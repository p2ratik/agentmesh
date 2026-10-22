import { connectBus, type NatsConnection } from '@agentmesh/bus';
import { createLogger } from '@agentmesh/common';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { describe, expect, it, vi } from 'vitest';
import { openSession, startSession } from './session';

vi.mock('@agentmesh/bus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentmesh/bus')>()),
  connectBus: vi.fn(),
}));

const peer = {
  id: 'alice-agent',
  kind: 'agent',
  displayName: "Alice's Claude",
  owner: 'alice',
  status: 'online',
  statusNote: null,
  lastSeen: null,
  repo: null,
  branch: null,
  skills: [],
  areas: [],
  activeTasks: 0,
};

type Callback = (err: Error | null, msg: unknown) => void;

/**
 * A hub whose hellos hand out `ids` in order (one per hello); records each
 * hello's params, and the subscriptions, publishes and other requests (with
 * their session) in the order sent. Like the real hub, `session.check` sends a
 * check with code K7Q2ZP to the calling session's subject.
 */
function fakeHub(ids: string[], unreadThreads = 0) {
  const hellos: Array<Record<string, unknown>> = [];
  const wire: string[] = [];
  const listeners = new Map<string, Callback>();
  const answer = (result: unknown) => ({ json: () => ({ ok: true, result }) });
  const nc = {
    getServer: () => 'nats://hub.test:4222',
    publish: (subject: string, data: string) =>
      wire.push(`pub ${subject} ${JSON.parse(data).session}`),
    drain: async () => undefined,
    subscribe: (subject: string, opts: { callback: Callback }) => {
      wire.push(`sub ${subject}`);
      listeners.set(subject, opts.callback);
      return { unsubscribe: () => listeners.delete(subject) };
    },
    request: async (subject: string, data: string) => {
      const { params, session } = JSON.parse(data);
      if (!subject.endsWith('session.hello')) {
        wire.push(`req ${subject} ${session}`);
        if (subject.endsWith('session.check')) {
          const check = { type: 'check', code: 'K7Q2ZP' };
          listeners.get(`mesh.session.alice-agent.${session}`)?.(null, {
            subject,
            json: () => check,
            respond: () => true,
          });
        }
        return answer({ ok: true });
      }
      hellos.push(params);
      return answer({
        self: peer,
        mesh: { name: 'acme', prefix: 'mesh' },
        policy: {
          instructions: '',
          git: {
            integrationBranch: 'agents',
            protectedBranches: ['main'],
            branchTemplate: 'agent/{owner}/{task}-{slug}',
            agentsMayMergeInto: ['agents'],
          },
        },
        unreadThreads,
        sessionId: ids.shift(),
        reclaimed: [],
      });
    },
  } as unknown as NatsConnection;
  vi.mocked(connectBus).mockResolvedValue(nc);
  return { hellos, wire };
}

const logger = createLogger('test', { level: 'silent', destination: 'stderr' });
const config = { agentId: 'alice-agent', servers: [], prefix: 'mesh', heartbeatSeconds: 30 };
const pushes = (notification: ReturnType<typeof vi.fn>) =>
  notification.mock.calls.map(
    (call) => (call[0] as { params: { content: string; meta: Record<string, string> } }).params,
  );

describe('session listening', () => {
  // The hub marks a session away when a delivery finds nobody listening, until its next
  // heartbeat. A beat right after subscribing lets it deliver at once instead of a beat later.
  it('heartbeats right after it starts listening, at startup and after a re-hello', async () => {
    const { wire } = fakeHub(['s-aaaaaaaaaaaa', 's-bbbbbbbbbbbb']);
    const session = await openSession(config, logger);
    const notification = vi.fn(async () => undefined);
    const stop = startSession({ notification } as unknown as Server, session, logger, 0);
    const sub = 'sub mesh.session.alice-agent.s-aaaaaaaaaaaa';
    await vi.waitFor(() => expect(wire).toContain(sub));
    expect(wire.slice(wire.indexOf(sub))).toEqual([
      sub,
      'pub mesh.presence.alice-agent s-aaaaaaaaaaaa',
    ]);

    session.hub.onSessionLost?.();
    const resub = 'sub mesh.session.alice-agent.s-bbbbbbbbbbbb';
    await vi.waitFor(() => expect(wire).toContain(resub));
    expect(wire.slice(wire.indexOf(resub))).toEqual([
      resub,
      'pub mesh.presence.alice-agent s-bbbbbbbbbbbb',
    ]);
    await stop();
  });

  // Every new session is inactive, and an inactive session is never interrupted (spec §2, §3).
  it('pushes nothing at startup, even with unread threads waiting', async () => {
    const { wire } = fakeHub(['s-aaaaaaaaaaaa'], 3);
    const session = await openSession(config, logger);
    const notification = vi.fn(async () => undefined);
    const stop = startSession({ notification } as unknown as Server, session, logger, 0);
    await vi.waitFor(() => expect(wire).toContain('sub mesh.session.alice-agent.s-aaaaaaaaaaaa'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notification).not.toHaveBeenCalled();
    await stop();
  });

  it('a call made while a hello is in flight carries the session it opens', async () => {
    const { hellos, wire } = fakeHub(['s-aaaaaaaaaaaa', 's-bbbbbbbbbbbb']);
    const session = await openSession(config, logger);
    session.hub.sessionId = null;
    const hello = session.sayHello();
    await Promise.all([hello, session.hub.call('session.bye', {})]);
    expect(wire).toContain('req mesh.rpc.alice-agent.session.bye s-bbbbbbbbbbbb');
    expect(hellos).toHaveLength(2);
  });

  // Without a session the hub refuses the call as if the plugin were too old to have one.
  it('a call with no session says hello first', async () => {
    const { hellos, wire } = fakeHub(['s-aaaaaaaaaaaa', 's-bbbbbbbbbbbb']);
    const session = await openSession(config, logger);
    // As after a first hello that failed while NATS stayed up: no session, no hello in flight.
    session.hub.sessionId = null;
    await session.hub.call('session.check', {});
    expect(hellos).toHaveLength(2);
    expect(wire).toContain('req mesh.rpc.alice-agent.session.check s-bbbbbbbbbbbb');
  });
});

describe('session renewal', () => {
  it('asks the hub for a new check when an active session comes back as a new one', async () => {
    const { hellos, wire } = fakeHub([
      's-aaaaaaaaaaaa',
      's-aaaaaaaaaaaa',
      's-bbbbbbbbbbbb',
      's-cccccccccccc',
    ]);
    const session = await openSession(config, logger);
    const notification = vi.fn(async () => undefined);
    const stop = startSession({ notification } as unknown as Server, session, logger, 0);
    await vi.waitFor(() => expect(wire).toContain('sub mesh.session.alice-agent.s-aaaaaaaaaaaa'));

    // The same session again (a short sleep): nothing to re-check.
    session.activation.lastDescription = 'checkout redesign';
    await session.sayHello();
    expect(hellos[1]).toMatchObject({ previousSessionId: 's-aaaaaaaaaaaa' });
    expect(notification).not.toHaveBeenCalled();

    // A new session after a long absence: the hub's check reaches Claude suggesting the old line.
    await session.sayHello();
    expect(session.hub.sessionId).toBe('s-bbbbbbbbbbbb');
    await vi.waitFor(() => expect(notification).toHaveBeenCalledOnce());
    expect(wire).toContain('req mesh.rpc.alice-agent.session.check s-bbbbbbbbbbbb');
    const [check] = pushes(notification);
    expect(check?.meta).toEqual({ kind: 'system', from: 'agentmesh' });
    expect(check?.content).toContain('reconnected to the mesh after a long absence');
    expect(check?.content).toContain('Code: K7Q2ZP.');
    expect(check?.content).toContain('description: "checkout redesign"');

    // A session that was not active stays quiet when it is renewed.
    session.activation.lastDescription = null;
    await session.sayHello();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notification).toHaveBeenCalledOnce();
    await stop();
  });
});
