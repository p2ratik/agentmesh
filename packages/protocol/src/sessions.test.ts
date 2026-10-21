import { describe, expect, it } from 'vitest';
import { PeerInfo } from './primitives';
import { RPC_METHODS } from './rpc';
import { SessionId, SessionInbound } from './sessions';
import { subjects } from './subjects';

const minimalPeer = {
  id: 'alice-agent',
  kind: 'agent',
  displayName: 'Alice',
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

describe('session contracts', () => {
  it('builds session and ack subjects under the prefix', () => {
    const s = subjects('mesh');
    expect(s.session('alice-agent', 's-abc123def456')).toBe(
      'mesh.session.alice-agent.s-abc123def456',
    );
    expect(s.sessionAll('alice-agent')).toBe('mesh.session.alice-agent.*');
    expect(s.ack('alice-agent', 'tok')).toBe('mesh.ack.alice-agent.tok');
    expect(s.ackAll('alice-agent')).toBe('mesh.ack.alice-agent.>');
  });

  it('accepts hub-issued session ids only', () => {
    expect(SessionId.safeParse('s-abc123def456').success).toBe(true);
    expect(SessionId.safeParse('s-ABC.def').success).toBe(false);
  });

  it('parses a deliver batch, an expiry notice and an activation check', () => {
    expect(SessionInbound.parse({ type: 'expired' })).toEqual({ type: 'expired' });
    expect(SessionInbound.safeParse({ type: 'deliver', messages: [] }).success).toBe(false);
    expect(SessionInbound.parse({ type: 'check', code: 'K7Q2ZP' })).toEqual({
      type: 'check',
      code: 'K7Q2ZP',
    });
    expect(SessionInbound.safeParse({ type: 'check' }).success).toBe(false);
  });

  it('session.take needs exactly one of threadId and taskId', () => {
    const p = RPC_METHODS['session.take'].params;
    expect(p.safeParse({ threadId: 'thr-1' }).success).toBe(true);
    expect(p.safeParse({}).success).toBe(false);
    expect(p.safeParse({ threadId: 'thr-1', taskId: 'task-1' }).success).toBe(false);
  });

  it('session methods are agent-only', () => {
    for (const m of [
      'session.check',
      'session.activate',
      'session.deactivate',
      'session.describe',
      'session.take',
    ]) {
      expect(RPC_METHODS[m as 'session.take'].callers).toEqual(['agent']);
    }
  });

  it("a deliver batch keeps each message's class and defaults to action", () => {
    const msg = {
      id: 'm1',
      threadId: 'thr-1',
      kind: 'ask',
      from: { id: 'bob-agent', kind: 'agent', displayName: 'Bob' },
      to: ['alice-agent'],
      subject: 's',
      body: 'b',
      status: null,
      trust: 'team',
      depth: 0,
      refs: {},
      createdAt: '2026-10-22T00:00:00.000Z',
    };
    const parsed = SessionInbound.parse({
      type: 'deliver',
      messages: [msg, { ...msg, id: 'm2', class: 'status' }],
    });
    if (parsed.type !== 'deliver') throw new Error('expected deliver');
    expect(parsed.messages.map((m) => m.class)).toEqual(['action', 'status']);
  });

  it('messages.seen needs at least one id and at most 500', () => {
    const p = RPC_METHODS['messages.seen'].params;
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
    expect(p.safeParse({ messageIds: [] }).success).toBe(false);
    expect(p.safeParse({ messageIds: ids(500) }).success).toBe(true);
    expect(p.safeParse({ messageIds: ids(501) }).success).toBe(false);
    expect(RPC_METHODS['messages.seen'].callers).toEqual(['agent']);
  });

  it('peers default to no sessions', () => {
    expect(PeerInfo.parse({ ...minimalPeer }).sessions).toEqual([]);
  });
});
