import { describe, expect, it } from 'vitest';
import { parseHeartbeat } from './listener';

describe('parseHeartbeat', () => {
  it('keeps the session id', () => {
    const body = '{"session":"s-abc123def456","branch":"b"}';
    expect(parseHeartbeat('mesh', 'mesh.presence.alice-agent', body)).toEqual({
      participantId: 'alice-agent',
      info: { session: 's-abc123def456', branch: 'b' },
    });
  });

  it('accepts an empty body and rejects junk', () => {
    expect(parseHeartbeat('mesh', 'mesh.presence.alice-agent', '')?.info).toEqual({});
    expect(parseHeartbeat('mesh', 'mesh.presence.alice-agent', 'nope')).toBeNull();
  });

  // The session id becomes a subject token when the hub answers an unknown session.
  it('ignores a heartbeat whose session is not a hub session id', () => {
    for (const session of ['a.>', 'ses_1', '*']) {
      const body = JSON.stringify({ session });
      expect(parseHeartbeat('mesh', 'mesh.presence.alice-agent', body)).toBeNull();
    }
  });
});
