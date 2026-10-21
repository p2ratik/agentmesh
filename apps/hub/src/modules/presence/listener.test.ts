import { describe, expect, it } from 'vitest';
import { parseHeartbeat } from './listener';

describe('parseHeartbeat', () => {
  it('keeps the session id', () => {
    const body = '{"session":"ses_1","branch":"b"}';
    expect(parseHeartbeat('mesh', 'mesh.presence.alice-agent', body)).toEqual({
      participantId: 'alice-agent',
      info: { session: 'ses_1', branch: 'b' },
    });
  });

  it('accepts an empty body and rejects junk', () => {
    expect(parseHeartbeat('mesh', 'mesh.presence.alice-agent', '')?.info).toEqual({});
    expect(parseHeartbeat('mesh', 'mesh.presence.alice-agent', 'nope')).toBeNull();
  });
});
