import { connectBus, type NatsConnection } from '@agentmesh/bus';
import { createLogger } from '@agentmesh/common';
import { describe, expect, it, vi } from 'vitest';
import { HubClient } from './hub';

vi.mock('@agentmesh/bus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentmesh/bus')>()),
  connectBus: vi.fn(),
}));

/** A connected HubClient whose hub answers from `replies`, in order; records request envelopes. */
async function connected(replies: unknown[]) {
  const envelopes: Array<Record<string, unknown>> = [];
  const nc = {
    getServer: () => 'nats://hub.test:4222',
    request: async (_subject: string, data: string) => {
      envelopes.push(JSON.parse(data));
      const reply = replies.shift();
      return { json: () => reply };
    },
  } as unknown as NatsConnection;
  vi.mocked(connectBus).mockResolvedValue(nc);
  const logger = createLogger('test', { level: 'silent', destination: 'stderr' });
  const config = { agentId: 'alice-agent', servers: [], prefix: 'mesh', heartbeatSeconds: 30 };
  const hub = new HubClient(config, logger);
  hub.connect();
  await hub.whenConnected();
  return { hub, envelopes };
}

const ok = (notes?: string[]) => ({ ok: true, result: { ok: true }, ...(notes ? { notes } : {}) });

describe('HubClient', () => {
  it('takeNotes returns and clears notes from the last calls', async () => {
    const { hub, envelopes } = await connected([ok(['owned by s-1']), ok(), ok(['take moves it'])]);
    hub.sessionId = 's-aaaaaaaaaaaa';
    await hub.call('session.bye', {});
    await hub.call('session.bye', {});
    await hub.call('session.bye', {});
    expect(envelopes.map((e) => e.session)).toEqual(Array(3).fill('s-aaaaaaaaaaaa'));
    expect(hub.takeNotes()).toEqual(['owned by s-1', 'take moves it']);
    expect(hub.takeNotes()).toEqual([]);
  });

  it('reports a session the hub no longer knows, and still fails the call', async () => {
    const { hub } = await connected([
      {
        ok: false,
        error: { code: 'not_found', message: 'Unknown or closed session s-x; reconnect' },
      },
    ]);
    hub.sessionId = 's-aaaaaaaaaaaa';
    const lost = vi.fn();
    hub.onSessionLost = lost;
    await expect(hub.call('session.bye', {})).rejects.toThrow('Unknown or closed session');
    expect(lost).toHaveBeenCalledOnce();
  });
});
