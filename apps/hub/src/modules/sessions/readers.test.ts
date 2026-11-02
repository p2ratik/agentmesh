import { describe, expect, it } from 'vitest';
import type { CallContext } from '../../contracts';
import { createBobDispatchHarness } from '../../testing/services';
import { readInbox } from '../messaging/inbox';
import type { MessagingServiceImpl } from '../messaging/messaging.service';
import { takeUnownedReader } from './readers';

describe('inbox.get claims', () => {
  it("an active session's inbox read makes it the owner of what it took", () => {
    const { active, thread, ask, sessions, messaging } = createBobDispatchHarness();
    const s = active();
    const t = thread();
    ask(t);
    const result = readInbox(messaging as MessagingServiceImpl, 'bob-agent', s, 20, 5);
    const actor = { id: 'bob-agent', kind: 'agent' as const, roles: [] };
    const call: CallContext = { actor, caller: actor, method: 'inbox.get', session: s, notes: [] };
    sessions.recordClaims(call, 'inbox.get', {}, result);
    expect(sessions.ownerOf(t, 'bob-agent')).toBe(s);
  });
});

describe('takeUnownedReader', () => {
  const setup = () => {
    const h = createBobDispatchHarness();
    return { ...h, take: takeUnownedReader(() => h.sessions) };
  };
  const open = (h: ReturnType<typeof setup>) =>
    h.sessions.open('bob-agent', { clientVersion: '0.2.0' }).session.id;

  it('lets an active push session take unowned work', () => {
    const h = setup();
    expect(h.take('bob-agent', h.active())).toBe(true);
  });

  it('refuses an inactive session', () => {
    const h = setup();
    expect(h.take('bob-agent', open(h))).toBe(false);
  });

  it('lets a pull session take only while no push session is ready', () => {
    const h = setup();
    const pull = open(h);
    h.sessions.activate('bob-agent', pull, 'desktop', 'pull');
    const push = h.active();
    expect(h.take('bob-agent', pull)).toBe(false);
    h.sessions.unreachable(push);
    expect(h.take('bob-agent', pull)).toBe(true);
  });

  it('answers false for a closed or unknown session instead of throwing', () => {
    const h = setup();
    expect(h.take('bob-agent', 's-zzzzzzzzzzzz')).toBe(false);
  });
});
