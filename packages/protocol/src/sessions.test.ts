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

  it('parses a deliver batch and an expiry notice', () => {
    expect(SessionInbound.parse({ type: 'expired' })).toEqual({ type: 'expired' });
    expect(SessionInbound.safeParse({ type: 'deliver', messages: [] }).success).toBe(false);
  });

  it('session.take needs exactly one of threadId and taskId', () => {
    const p = RPC_METHODS['session.take'].params;
    expect(p.safeParse({ threadId: 'thr-1' }).success).toBe(true);
    expect(p.safeParse({}).success).toBe(false);
    expect(p.safeParse({ threadId: 'thr-1', taskId: 'task-1' }).success).toBe(false);
  });

  it('session methods are agent-only', () => {
    for (const m of [
      'session.activate',
      'session.deactivate',
      'session.describe',
      'session.take',
    ]) {
      expect(RPC_METHODS[m as 'session.take'].callers).toEqual(['agent']);
    }
  });

  it('peers default to no sessions', () => {
    expect(PeerInfo.parse({ ...minimalPeer }).sessions).toEqual([]);
  });
});
