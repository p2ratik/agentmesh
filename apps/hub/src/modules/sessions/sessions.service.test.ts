import type { RpcMethodName, RpcParams } from '@agentmesh/protocol';
import { SESSION_ID_PATTERN } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { CallContext, RpcHandler } from '../../contracts';
import { internalId } from '../../core/ids';
import { buildModules } from '../../runtime/modules';
import { createTestHarness } from '../../testing/harness';
import { isAtLeast } from './version';

function setup() {
  const h = createTestHarness();
  const built = buildModules(h.ctx, null, { kick: null });
  const { sessions, messaging, presence, tasks } = built.services;
  const thread = (createdBy = 'alice-agent', participants = ['bob-agent']) =>
    messaging.createThread({ kind: 'conversation', subject: 'x', createdBy, participants }).id;
  const open = (agentId = 'alice-agent') =>
    sessions.open(agentId, { clientVersion: '0.2.0' }).session.id;
  const call = (session: string | null, id = 'alice-agent'): CallContext => {
    const actor = { id, kind: 'agent' as const, roles: [] };
    return { actor, caller: actor, method: 'message.send', session, notes: [] };
  };
  const claim = (session: string, threadId: number, method: RpcMethodName = 'message.send') => {
    const c = call(session);
    sessions.recordClaims(c, method, {}, { threadId: `thr-${threadId}` });
    return c;
  };
  const rpc = async <M extends RpcMethodName>(method: M, params: RpcParams<M>, c: CallContext) => {
    const handler = built.handlers[method] as RpcHandler<M> | undefined;
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params, { ...c, method });
  };
  const owner = (threadId: number, agentId = 'alice-agent') => sessions.ownerOf(threadId, agentId);
  return { ...h, sessions, messaging, presence, tasks, thread, open, call, claim, rpc, owner };
}

describe('sessions service', () => {
  it('opens an inactive live session with a hub id', () => {
    const { sessions } = setup();
    const { session, reclaimed } = sessions.open('alice-agent', {
      clientVersion: '0.2.0',
      repo: 'acme/api',
    });
    expect(session.id).toMatch(SESSION_ID_PATTERN);
    expect(session).toMatchObject({
      agentId: 'alice-agent',
      active: false,
      liveness: 'live',
      repo: 'acme/api',
    });
    expect(reclaimed).toEqual([]);
  });

  it("verify refuses another agent's session", () => {
    const { sessions, open } = setup();
    const s1 = open('alice-agent');
    expect(sessions.verify('alice-agent', s1).id).toBe(s1);
    expect(() => sessions.verify('bob-agent', s1)).toThrow(
      expect.objectContaining({ code: 'not_found', message: expect.stringContaining('reconnect') }),
    );
  });

  it('first acting session owns the thread; a second keeps it and gets a note', () => {
    const { thread, open, claim, owner } = setup();
    const t = thread();
    const [s1, s2] = [open(), open()];
    expect(claim(s1, t).notes).toEqual([]);
    expect(owner(t)).toBe(s1);
    const second = claim(s2, t);
    expect(owner(t)).toBe(s1);
    expect(second.notes[0]).toBe(
      `thr-${t} belongs to your session ${s1} (“no description”); its messages go there. ` +
        `Run /agentmesh:take thr-${t} to move it here.`,
    );
  });

  it('claims a plan contribution through the plan’s thread', async () => {
    const { sessions, rpc, call, open, owner } = setup();
    const s1 = open('carol-agent');
    const plan = await rpc('plan.start', { topic: 'Billing v2' }, call(null, 'carol-agent'));
    sessions.recordClaims(call(s1, 'carol-agent'), 'plan.contribute', { planId: plan.id }, {});
    expect(owner(internalId('thread', plan.threadId), 'carol-agent')).toBe(s1);
  });

  it('take moves ownership and reports the previous owner', async () => {
    const { sessions, tasks, thread, open, claim, owner, rpc, call } = setup();
    const t = thread();
    const [s1, s2] = [open(), open()];
    claim(s1, t);
    expect(sessions.take('alice-agent', s2, t)).toEqual({ previous: s1 });
    expect(owner(t)).toBe(s2);
    expect(() => sessions.take('carol-agent', open('carol-agent'), t)).toThrow(
      expect.objectContaining({ code: 'forbidden' }),
    );

    const actor = { id: 'alice-agent', kind: 'agent' as const, roles: [] };
    const task = tasks.create(
      { title: 'Retries', description: '', priority: 'normal', labels: [], dependsOn: [] },
      actor,
    );
    const taken = await rpc('session.take', { taskId: task.id }, call(s1));
    expect(taken).toEqual({ threadId: task.threadId, previousSession: null });
  });

  it('bye releases ownership; a reconnect reclaims what nobody took', () => {
    const { sessions, thread, open, claim, owner } = setup();
    const [t1, t2] = [thread(), thread()];
    const s1 = open();
    claim(s1, t1);
    claim(s1, t2);
    sessions.close('alice-agent', s1);
    expect(owner(t1)).toBeNull();
    const s2 = open();
    claim(s2, t2);
    const again = sessions.open('alice-agent', { clientVersion: '0.2.0', previousSessionId: s1 });
    expect(again.session.id).not.toBe(s1);
    expect(again.reclaimed).toEqual([t1]);
    expect(owner(t1)).toBe(again.session.id);
    expect(owner(t2)).toBe(s2);
    const reused = sessions.open('alice-agent', { clientVersion: '0.2.0', previousSessionId: s2 });
    expect(reused).toMatchObject({ session: { id: s2 }, reclaimed: [] });
  });

  it('deactivate releases ownership; the next message routes to another active session', () => {
    const { sessions, messaging, thread, open, claim, owner } = setup();
    const t = thread('bob-agent', ['alice-agent']);
    const [s1, s2] = [open(), open()];
    sessions.activate('alice-agent', s1, 'billing api');
    sessions.activate('alice-agent', s2, 'status codes');
    claim(s2, t);
    sessions.deactivate('alice-agent', s2);
    expect(owner(t)).toBeNull();
    const next = messaging.post({
      threadId: t,
      senderId: 'bob-agent',
      kind: 'reply',
      body: 'more',
    });
    expect(sessions.route('alice-agent', next.message)).toMatchObject({
      kind: 'deliver',
      sessionId: s1,
    });
    // Re-activating takes nothing back: work moves by routing or take.
    sessions.activate('alice-agent', s2, 'status codes');
    expect(owner(t)).toBeNull();
  });

  it('bye keeps the agent online while another of its sessions lives', async () => {
    const { presence, open, rpc, call } = setup();
    presence.touch('alice-agent');
    const [s1, s2] = [open(), open()];
    await rpc('session.bye', {}, call(s1));
    expect(presence.isOnline('alice-agent')).toBe(true);
    await rpc('session.bye', {}, call(s2));
    expect(presence.isOnline('alice-agent')).toBe(false);
  });

  it('hello refuses plugins older than 0.2.0', async () => {
    const { rpc, call } = setup();
    await expect(
      rpc('session.hello', { clientVersion: '0.1.7' }, call(null)),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('claude plugin update'),
    });
    const hello = await rpc('session.hello', { clientVersion: '0.2.0' }, call(null));
    expect(hello.sessionId).toMatch(SESSION_ID_PATTERN);
    expect(hello.reclaimed).toEqual([]);
    expect(hello.self.status).toBe('online');
  });

  it('peers list active sessions only', async () => {
    const { sessions, presence, tasks, open, claim, owner, clock } = setup();
    const [idle, s2] = [open(), open()];
    const actor = { id: 'alice-agent', kind: 'agent' as const, roles: [] };
    const task = tasks.create(
      { title: 'Checkout', description: '', priority: 'normal', labels: [], dependsOn: [] },
      actor,
    );
    const taskThread = internalId('thread', task.threadId);
    claim(s2, taskThread, 'task.create');
    const listed = () => presence.peers('agent').find((p) => p.id === 'alice-agent')?.sessions;
    expect(listed()).toEqual([]);

    const secret = ['password = "', 'hunter2hunter2"'].join('');
    sessions.activate('alice-agent', s2, `checkout redesign ${secret}`);
    expect(sessions.view(s2).description).not.toContain('hunter2');
    sessions.describe('alice-agent', s2, 'checkout redesign');
    expect(listed()).toEqual([
      {
        id: s2,
        description: 'checkout redesign',
        repo: null,
        branch: null,
        activeSince: clock.now().toISOString(),
        tasks: [task.id],
      },
    ]);
    expect(listed()?.map((s) => s.id)).not.toContain(idle);

    sessions.deactivate('alice-agent', s2);
    expect(listed()).toEqual([]);
    expect(owner(taskThread)).toBeNull();
  });
});

describe('message.send toSession', () => {
  async function picked() {
    const h = setup();
    const bob = h.open('bob-agent');
    h.sessions.activate('bob-agent', bob, 'web client');
    const send = (params: Partial<RpcParams<'message.send'>>) =>
      h.rpc('message.send', { kind: 'ask', body: 'Handles 418?', ...params }, h.call(null));
    return { ...h, bob, send };
  }

  it('lands a valid pick and the repo in the message refs', async () => {
    const { send, bob, rpc, call } = await picked();
    const sent = await send({ to: ['bob-agent'], toSession: bob, repo: 'acme/web' });
    const read = await rpc('thread.get', { threadId: sent.threadId, limit: 50 }, call(null));
    expect(read.messages[0]?.refs).toMatchObject({ session: bob, repo: 'acme/web' });
  });

  it('refuses a pick unless it names one agent recipient', async () => {
    const { send, bob } = await picked();
    for (const to of [['bob-agent', 'carol-agent'], ['bob']]) {
      await expect(send({ to, toSession: bob })).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
  });

  it('refuses another agent’s session or an inactive one', async () => {
    const { send, open, sessions } = await picked();
    const carol = open('carol-agent');
    sessions.activate('carol-agent', carol, 'infra');
    const idle = open('bob-agent');
    for (const toSession of [carol, idle]) {
      await expect(send({ to: ['bob-agent'], toSession })).rejects.toMatchObject({
        code: 'invalid_request',
        message: expect.stringContaining('not an active session of bob-agent'),
      });
    }
  });
});

describe('isAtLeast', () => {
  it('compares dotted versions numerically and treats junk as old', () => {
    expect(isAtLeast('0.2.0', '0.2.0')).toBe(true);
    expect(isAtLeast('0.10.0', '0.2.0')).toBe(true);
    expect(isAtLeast('1', '0.2.0')).toBe(true);
    expect(isAtLeast('0.1.7', '0.2.0')).toBe(false);
    for (const junk of ['test', '', '0.2.0-beta', 'v0.2.0', '0..2']) {
      expect(isAtLeast(junk, '0.2.0')).toBe(false);
    }
  });
});
