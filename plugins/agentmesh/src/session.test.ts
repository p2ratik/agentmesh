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

/**
 * A hub whose hellos hand out `ids` in order (one per hello); records each
 * hello's params, and the subscriptions and publishes in the order sent.
 */
function fakeHub(ids: string[]) {
  const hellos: Array<Record<string, unknown>> = [];
  const wire: string[] = [];
  const nc = {
    getServer: () => 'nats://hub.test:4222',
    publish: (subject: string, data: string) =>
      wire.push(`pub ${subject} ${JSON.parse(data).session}`),
    drain: async () => undefined,
    subscribe: (subject: string) => {
      wire.push(`sub ${subject}`);
      return { unsubscribe: () => undefined };
    },
    request: async (subject: string, data: string) => {
      const { params } = JSON.parse(data);
      if (!subject.endsWith('session.hello'))
        return { json: () => ({ ok: true, result: { ok: true } }) };
      hellos.push(params);
      const result = {
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
        unreadThreads: 0,
        sessionId: ids.shift(),
        reclaimed: [],
      };
      return { json: () => ({ ok: true, result }) };
    },
  } as unknown as NatsConnection;
  vi.mocked(connectBus).mockResolvedValue(nc);
  return { hellos, wire };
}

const logger = createLogger('test', { level: 'silent', destination: 'stderr' });
const config = { agentId: 'alice-agent', servers: [], prefix: 'mesh', heartbeatSeconds: 30 };

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
});

describe('session renewal', () => {
  it('re-runs the activation check when an active session comes back as a new one', async () => {
    const { hellos } = fakeHub([
      's-aaaaaaaaaaaa',
      's-aaaaaaaaaaaa',
      's-bbbbbbbbbbbb',
      's-cccccccccccc',
    ]);
    const session = await openSession(config, logger);
    const notification = vi.fn(async () => undefined);
    const stop = startSession({ notification } as unknown as Server, session, logger, 60_000);

    // The same session again (a short sleep): nothing to re-check.
    session.activation.lastDescription = 'checkout redesign';
    await session.sayHello();
    expect(hellos[1]).toMatchObject({ previousSessionId: 's-aaaaaaaaaaaa' });
    expect(notification).not.toHaveBeenCalled();

    // A new session after a long absence: Claude gets a fresh check suggesting the old line.
    await session.sayHello();
    expect(session.hub.sessionId).toBe('s-bbbbbbbbbbbb');
    expect(notification).toHaveBeenCalledOnce();
    const { content, meta } = (
      notification.mock.calls[0] as unknown as [
        { params: { content: string; meta: Record<string, string> } },
      ]
    )[0].params;
    expect(meta).toEqual({ kind: 'system', from: 'agentmesh' });
    expect(content).toContain('reconnected to the mesh after a long absence');
    expect(content).toContain('description: "checkout redesign"');
    const code = /Code: ([A-Z2-9]{6})\./.exec(content)?.[1] ?? '';
    expect(session.activation.verify(code)).toBe(true);

    // A session that was not active stays quiet when it is renewed.
    session.activation.lastDescription = null;
    await session.sayHello();
    expect(notification).toHaveBeenCalledOnce();
    await stop();
  });
});
