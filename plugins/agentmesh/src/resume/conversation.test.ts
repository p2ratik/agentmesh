import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HubClient } from '../hub';
import { newActivationState } from '../tools/activation';
import { byeQuietly, followConversation, followEvery, reclaimedLines } from './conversation';

const A = '0b6c1a52-3e9f-4d2a-9c11-5f2e8a7d4b10';
const B = '7d1e0c3a-2b4f-4e6a-8c9d-1a2b3c4d5e6f';

/**
 * A session of conversation `prev` with hub session s-1; the fake hub records calls in order, and
 * each bye's options with this process's session while it is out. A bye waits for `gate.bye`.
 */
function session(prev: string | null, active = false) {
  const calls: Array<[string, unknown]> = [];
  const byes: Array<{ options: unknown; current: string | null }> = [];
  const gate = { bye: Promise.resolve() };
  const hub = {
    sessionId: 's-aaaaaaaaaaaa' as string | null,
    call: async (method: string, params: unknown, options?: unknown) => {
      calls.push([method, params]);
      if (method === 'session.bye') {
        byes.push({ options, current: hub.sessionId });
        await gate.bye;
      }
      return { ok: true };
    },
  };
  const activation = { ...newActivationState(), lastDescription: active ? 'api work' : null };
  const s = {
    claudeSessionId: prev,
    activation,
    hub: hub as unknown as HubClient,
    sayHello: async () => {
      const previous = hub.sessionId ? { previousSessionId: hub.sessionId } : {};
      calls.push(['session.hello', previous]);
      return null;
    },
  };
  return { s, calls, hub, byes, gate };
}

const BYE_OPTIONS = { timeoutMs: 250, session: 's-aaaaaaaaaaaa' };

afterEach(() => vi.useRealTimers());

describe('followConversation', () => {
  it('does nothing without an id or for the same one', async () => {
    for (const next of [null, A]) {
      const { s, calls } = session(A);
      await followConversation(s, next);
      expect([s.claudeSessionId, calls]).toEqual([A, []]);
    }
    const { s, calls } = session(null);
    await followConversation(s, null);
    expect([s.claudeSessionId, calls]).toEqual([null, []]);
  });

  it('learns a late id: hello again, keeping the hub session', async () => {
    const { s, calls } = session(null);
    await followConversation(s, A);
    expect(s.claudeSessionId).toBe(A);
    expect(calls).toEqual([['session.hello', { previousSessionId: 's-aaaaaaaaaaaa' }]]);
  });

  it('after a /clear in an inactive session, says bye and hello as a new session', async () => {
    const { s, calls, hub, byes } = session(A);
    await followConversation(s, B);
    expect(s.claudeSessionId).toBe(B);
    expect(calls).toEqual([
      ['session.bye', {}],
      ['session.hello', {}],
    ]);
    // The old session is named on the bye and already let go while the bye is out.
    expect(byes).toEqual([{ options: BYE_OPTIONS, current: null }]);
    expect(hub.sessionId).toBeNull();
  });

  // Review I1: a bye with no session would open one (a call says hello first) and close it.
  it('with no hub session, a /clear sends no bye, only a hello', async () => {
    const { s, calls, hub } = session(A);
    hub.sessionId = null;
    await followConversation(s, B);
    expect(calls).toEqual([['session.hello', {}]]);
  });

  // Review I1: a re-hello naming the old session would reclaim the old conversation's threads.
  it('a session lost while the bye is out says hello without the old session', async () => {
    const { s, calls, gate } = session(A);
    const bye = Promise.withResolvers<void>();
    gate.bye = bye.promise;
    const following = followConversation(s, B);
    await vi.waitFor(() => expect(calls).toEqual([['session.bye', {}]]));
    await s.sayHello(); // a tool call got not_found, so onSessionLost says hello
    bye.resolve();
    await following;
    expect(calls.filter(([method]) => method === 'session.hello')).toEqual([
      ['session.hello', {}],
      ['session.hello', {}],
    ]);
  });

  it('an active session keeps its hub session: it only notes the new id', async () => {
    for (const pull of [false, true]) {
      const { s, calls } = session(A, !pull);
      s.activation.pull = pull;
      await followConversation(s, B);
      expect([s.claudeSessionId, calls]).toEqual([B, []]);
    }
  });
});

describe('byeQuietly', () => {
  it('says bye only for a session, naming it, and never as a new one', async () => {
    const { hub, byes } = session(A);
    const client = hub as unknown as HubClient;
    await byeQuietly(client);
    await byeQuietly(client, null);
    hub.sessionId = null;
    await byeQuietly(client);
    expect(byes).toEqual([{ options: BYE_OPTIONS, current: 's-aaaaaaaaaaaa' }]);
  });
});

describe('followEvery', () => {
  it('reads the record every 30 s until stopped', async () => {
    vi.useFakeTimers();
    const { s, calls } = session(null);
    const read = vi.fn(() => A);
    const stop = followEvery(s, read);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect([s.claudeSessionId, calls.length]).toEqual([A, 1]);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledOnce();
  });
});

describe('reclaimedLines', () => {
  it('says where each reclaimed thread has come back', () => {
    expect(reclaimedLines(['thr-12', 'thr-3'])).toBe(
      'Your earlier question in thr-12 has come back to this session; read it with thread thr-12 for its answer.\n' +
        'Your earlier question in thr-3 has come back to this session; read it with thread thr-3 for its answer.',
    );
  });
});
