import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HubClient } from '../hub';
import { newActivationState } from '../tools/activation';
import { followConversation, followEvery, reclaimedLines } from './conversation';

const A = '0b6c1a52-3e9f-4d2a-9c11-5f2e8a7d4b10';
const B = '7d1e0c3a-2b4f-4e6a-8c9d-1a2b3c4d5e6f';

/** A session of conversation `prev` with hub session s-1; the fake hub records calls in order. */
function session(prev: string | null, active = false) {
  const calls: Array<[string, unknown]> = [];
  const hub = {
    sessionId: 's-aaaaaaaaaaaa' as string | null,
    call: async (method: string, params: unknown) => {
      calls.push([method, params]);
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
  return { s, calls, hub };
}

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
    const { s, calls, hub } = session(A);
    await followConversation(s, B);
    expect(s.claudeSessionId).toBe(B);
    expect(calls).toEqual([
      ['session.bye', {}],
      ['session.hello', {}],
    ]);
    expect(hub.sessionId).toBeNull();
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
