import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '@agentmesh/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from './inbox/session-inbox.fixture';
import { PullWatcher } from './pull/watcher';
import { writeClaudeSession } from './resume/claude-session';
import { openSession, startSession } from './session';
import { config, fakeHub, fakeServer, logger, pushes } from './session.fixture';

vi.mock('@agentmesh/bus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentmesh/bus')>()),
  connectBus: vi.fn(),
}));

describe('session listening', () => {
  // The hub marks a session away when a delivery finds nobody listening, until its next
  // heartbeat. A beat right after subscribing lets it deliver at once instead of a beat later.
  it('heartbeats right after it starts listening, at startup and after a re-hello', async () => {
    const { wire } = fakeHub(['s-aaaaaaaaaaaa', 's-bbbbbbbbbbbb']);
    const session = await openSession(config, logger);
    const stop = startSession(fakeServer().server, session, logger, 0);
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
    const { notification, server } = fakeServer();
    const stop = startSession(server, session, logger, 0);
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

describe("the session's conversation", () => {
  const id = '0b6c1a52-3e9f-4d2a-9c11-5f2e8a7d4b10';
  let data: string;
  // Never the real ~/.agentmesh/run: the record and anything the watcher writes go to a temp folder.
  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), 'am-session-'));
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data);
    vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '');
    vi.stubEnv('AGENTMESH_RELAY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(data, { recursive: true, force: true });
  });

  it('hello carries claudeSessionId when the record exists', async () => {
    const { hellos } = fakeHub(['s-aaaaaaaaaaaa', 's-bbbbbbbbbbbb']);
    expect((await openSession(config, logger)).claudeSessionId).toBeNull();
    expect(hellos[0]).not.toHaveProperty('claudeSessionId');
    writeClaudeSession(data, process.ppid, { session_id: id, source: 'startup' }, new Date());
    const session = await openSession(config, logger);
    expect(session.claudeSessionId).toBe(id);
    expect(hellos[1]).toMatchObject({ claudeSessionId: id });
  });

  it('a hello that reclaims threads leaves a notice and counts the session as used', async () => {
    fakeHub(['s-aaaaaaaaaaaa'], 0, ['thr-12']);
    const used = vi.spyOn(PullWatcher.prototype, 'markUsed');
    const session = await openSession(config, logger);
    expect(session.notices).toEqual([
      'thr-12 is back with this session, which held it before the hub closed it; read it with thread thr-12 to catch up.',
    ]);
    expect(used).toHaveBeenCalledOnce();
    used.mockRestore();
  });
});

describe('session renewal', () => {
  let data: string;
  // An active session writes its heartbeat (and a pull one its state): never in the real home.
  // Not a mesh window either, even when the tests run in one.
  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), 'am-session-'));
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data);
    vi.stubEnv('AGENTMESH_MESH_WINDOW', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(data, { recursive: true, force: true });
  });

  it('re-activates itself when an active session comes back as a new one', async () => {
    const { hellos, wire, sent } = fakeHub([
      's-aaaaaaaaaaaa',
      's-aaaaaaaaaaaa',
      's-bbbbbbbbbbbb',
      's-cccccccccccc',
      's-dddddddddddd',
    ]);
    const session = await openSession(config, logger);
    const { notification, server } = fakeServer();
    const stop = startSession(server, session, logger, 0);
    await vi.waitFor(() => expect(wire).toContain('sub mesh.session.alice-agent.s-aaaaaaaaaaaa'));

    // The same session again (a short sleep): nothing to re-check.
    session.activation.lastDescription = 'checkout redesign';
    await session.sayHello();
    expect(hellos[1]).toMatchObject({ previousSessionId: 's-aaaaaaaaaaaa' });
    expect(notification).not.toHaveBeenCalled();

    // A new session after a long absence: this process's pushes were already proven, so it
    // answers the hub's check itself with the old line, and only tells Claude.
    await session.sayHello();
    expect(session.hub.sessionId).toBe('s-bbbbbbbbbbbb');
    await vi.waitFor(() => expect(notification).toHaveBeenCalledOnce());
    expect(wire).toContain('req mesh.rpc.alice-agent.session.check s-bbbbbbbbbbbb');
    const activate = 'mesh.rpc.alice-agent.session.activate';
    expect(wire).toContain(`req ${activate} s-bbbbbbbbbbbb`);
    expect(sent).toContainEqual([activate, { code: 'K7Q2ZP', description: 'checkout redesign' }]);
    const [again] = pushes(notification);
    expect(again?.meta).toEqual({ kind: 'system', from: 'agentmesh' });
    expect(again?.content).toContain('is active again as "checkout redesign"');
    expect(session.activation.renewedFrom).toBeNull();

    // A pull session re-activates in pull mode at once: no check.
    session.activation.pull = true;
    await session.sayHello();
    const pull = { mode: 'pull', description: 'checkout redesign' };
    await vi.waitFor(() => expect(sent).toContainEqual([activate, pull]));
    expect(wire).not.toContain('req mesh.rpc.alice-agent.session.check s-cccccccccccc');

    // A session that was not active stays quiet when it is renewed.
    session.activation.pull = false;
    session.activation.lastDescription = null;
    await session.sayHello();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notification).toHaveBeenCalledOnce();
    await stop();
  });
});

describe("a closed asker's notice", () => {
  let data: string;
  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), 'am-session-'));
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(data, { recursive: true, force: true });
  });

  it("uses the hub's minutes from a hello that landed after the startup wait", async () => {
    const { listeners, policy } = fakeHub(['s-aaaaaaaaaaaa', 's-aaaaaaaaaaaa']);
    const session = await openSession(config, logger);
    session.hello = null; // what openSession keeps when the first hello misses HELLO_WAIT_MS
    policy.closedAskerEscalationMinutes = 30;
    await session.sayHello();
    const { notification, server } = fakeServer();
    const stop = startSession(server, session, logger, 0);
    const subject = 'mesh.session.alice-agent.s-aaaaaaaaaaaa';
    await vi.waitFor(() => expect(listeners.has(subject)).toBe(true));
    const marker = { bySession: 's-bbbbbbbbbbbb', closedAt: '2026-11-04T09:30:00.000Z' };
    const released = { ...message('a1', 'thr-7'), released: { ...marker, claudeSessionId: null } };
    const json = () => ({ type: 'deliver', messages: [released] });
    listeners.get(subject)?.(null, { subject, json, respond: () => true });
    await vi.waitFor(() => expect(notification).toHaveBeenCalledOnce());
    expect(pushes(notification)[0]?.content).toContain('within 30 minutes');
    await stop();
  });
});

describe("the session's timeline events", () => {
  let data: string;
  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), 'am-session-'));
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data);
    vi.stubEnv('AGENTMESH_MESH_WINDOW', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(data, { recursive: true, force: true });
  });

  it('a hello records connected with the Claude Code version', async () => {
    const { hello } = fakeHub(['s-aaaaaaaaaaaa', 's-bbbbbbbbbbbb']);
    hello.observability = { enabled: true, maxBufferedEvents: 500 };
    const session = await openSession(config, logger);
    // Claude Code's version is known after its handshake, so the startup hello records then.
    expect(session.recorder.take(10)).toEqual([]);
    const stop = startSession(fakeServer().server, session, logger, 0);
    const connected = {
      kind: 'connected',
      source: 'plugin',
      session: 's-aaaaaaaaaaaa',
      pluginVersion: VERSION,
      claudeCodeVersion: '2.1.319',
      os: process.platform,
      arch: process.arch,
      node: process.versions.node,
      meshWindow: false,
      pull: false,
    };
    expect(session.recorder.take(10)).toMatchObject([connected]);

    // A renewal records it again, on the new session; so does NATS trouble.
    await session.sayHello();
    session.hub.onStatus?.('disconnect');
    expect(session.recorder.take(10)).toMatchObject([
      { ...connected, session: 's-bbbbbbbbbbbb' },
      { kind: 'nats', source: 'plugin', session: 's-bbbbbbbbbbbb', event: 'disconnect' },
    ]);
    await stop();
  });

  // The events just before a session closes are the ones an operator debugs.
  it('shutdown sends a last report before the bye, within the shutdown budget', async () => {
    const { hello, hang, wire } = fakeHub(['s-aaaaaaaaaaaa']);
    hello.observability = { enabled: true, maxBufferedEvents: 500 };
    const session = await openSession(config, logger);
    const stop = startSession(fakeServer().server, session, logger, 0); // records connected
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      hang.add('telemetry.report').add('session.bye');
      let closed = false;
      void stop().then(() => {
        closed = true;
      });
      // Both hang: the report waits 100 ms and the bye the rest of the 250 ms.
      await vi.advanceTimersByTimeAsync(240);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      expect(closed).toBe(true);
      const report = wire.indexOf('req mesh.rpc.alice-agent.telemetry.report s-aaaaaaaaaaaa');
      const bye = wire.indexOf('req mesh.rpc.alice-agent.session.bye s-aaaaaaaaaaaa');
      expect(report).toBeGreaterThan(-1);
      expect(bye).toBeGreaterThan(report);
    } finally {
      vi.useRealTimers();
    }
  });
});
