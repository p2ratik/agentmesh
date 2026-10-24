import type { NatsConnection } from '@agentmesh/bus';
import { describe, expect, it, vi } from 'vitest';
import { createTestHarness, joinTeam, leaveTeam } from '../../testing/harness';
import { createPresenceModule } from './index';
import { parseHeartbeat, startPresenceListener } from './listener';

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

describe('startPresenceListener', () => {
  /** A real presence service and a fake connection whose heartbeats the test publishes. */
  function listen() {
    const h = createTestHarness();
    const presence = createPresenceModule(h.ctx).service;
    type Callback = (err: Error | null, msg: { subject: string; string(): string }) => void;
    let deliver: Callback = () => undefined;
    const nc = {
      subscribe: (_subject: string, opts: { callback: Callback }) => {
        deliver = opts.callback;
        return { unsubscribe: () => undefined };
      },
    } as unknown as NatsConnection;
    const onSession = vi.fn(() => 'ok' as const);
    startPresenceListener(nc, 'mesh', presence, () => h.ctx.index, h.ctx.logger, onSession);
    const beat = (id: string) => {
      const body = JSON.stringify({ session: 's-abc123def456' });
      deliver(null, { subject: `mesh.presence.${id}`, string: () => body });
    };
    return { h, presence, onSession, beat };
  }

  it('accepts heartbeats from an agent who joined by invite after the hub started', () => {
    const { h, presence, onSession, beat } = listen();
    joinTeam(h.ctx, 'dana');
    presence.syncFromConfig(); // what the enrollment module does after a join
    beat('dana-agent');
    expect(presence.isOnline('dana-agent')).toBe(true);
    expect(onSession).toHaveBeenCalledWith('dana-agent', 's-abc123def456', {});
  });

  it('refuses humans, services, strangers and members who left after the hub started', () => {
    const { h, presence, onSession, beat } = listen();
    leaveTeam(h.ctx, 'bob');
    presence.syncFromConfig();
    for (const id of ['bob-agent', 'alice', 'hermes', 'mallory-agent']) beat(id);
    expect(onSession).not.toHaveBeenCalled();
    expect(presence.isOnline('bob-agent')).toBe(false);
    beat('alice-agent');
    expect(onSession).toHaveBeenCalledOnce();
  });
});
