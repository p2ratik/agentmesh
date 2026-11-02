import { describe, expect, it } from 'vitest';
import type { CallContext } from '../../contracts';
import { createBobDispatchHarness } from '../../testing/services';

const setup = () => {
  const h = createBobDispatchHarness();
  const priv = () => h.sessions.open('bob-agent', { clientVersion: '0.2.0' }).session.id;
  const callAs = (session: string): CallContext => {
    const actor = { id: 'bob-agent', kind: 'agent' as const, roles: [] };
    return { actor, caller: actor, method: 'message.send', session, notes: [] };
  };
  return { ...h, priv, callAs };
};

describe('claims by an inactive (private) session', () => {
  it('a private session owns the conversation it asks in', () => {
    const { priv, thread, sessions, callAs } = setup();
    const s = priv();
    const t = thread();
    sessions.recordClaims(callAs(s), 'message.send', {}, { threadId: `thr-${t}` });
    expect(sessions.ownerOf(t, 'bob-agent')).toBe(s);
  });

  it('a private session does not own a task it creates', () => {
    const { priv, thread, sessions, callAs } = setup();
    const s = priv();
    const t = thread();
    sessions.recordClaims(callAs(s), 'task.create', {}, { threadId: `thr-${t}` });
    expect(sessions.ownerOf(t, 'bob-agent')).toBeNull();
  });

  it('an active session still owns the task it creates', () => {
    const { active, thread, sessions, callAs } = setup();
    const s = active();
    const t = thread();
    sessions.recordClaims(callAs(s), 'task.create', {}, { threadId: `thr-${t}` });
    expect(sessions.ownerOf(t, 'bob-agent')).toBe(s);
  });

  it('a private session replying in a task thread does not own it', () => {
    const { priv, messaging, sessions, callAs } = setup();
    const s = priv();
    const t = messaging.createThread({
      kind: 'task',
      subject: 'x',
      createdBy: 'alice-agent',
      participants: ['bob-agent'],
    }).id;
    sessions.recordClaims(callAs(s), 'message.send', {}, { threadId: `thr-${t}` });
    expect(sessions.ownerOf(t, 'bob-agent')).toBeNull();
  });

  it("a child thread of a private session's conversation goes to an active session", () => {
    const { priv, active, thread, messaging, sessions, callAs, ask } = setup();
    const s = priv();
    const parent = thread();
    sessions.recordClaims(callAs(s), 'message.send', {}, { threadId: `thr-${parent}` });
    const s2 = active();
    const child = messaging.createThread({
      kind: 'conversation',
      subject: 'y',
      createdBy: 'alice-agent',
      participants: ['bob-agent'],
      parentThreadId: parent,
    }).id;
    expect(sessions.route('bob-agent', ask(child))).toMatchObject({
      kind: 'deliver',
      sessionId: s2,
    });
    expect(sessions.effectiveOwner(child, 'bob-agent')).toBeNull();
  });
});
