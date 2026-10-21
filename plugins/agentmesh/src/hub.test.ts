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
  it('puts the hub notes of a call into that call’s sink only', async () => {
    const { hub, envelopes } = await connected([ok(['owned by s-1']), ok(['dropped']), ok()]);
    hub.sessionId = 's-aaaaaaaaaaaa';
    const first: string[] = [];
    const third: string[] = [];
    await hub.call('session.bye', {}, {}, first);
    await hub.call('session.bye', {});
    await hub.call('session.bye', {}, {}, third);
    expect(envelopes.map((e) => e.session)).toEqual(Array(3).fill('s-aaaaaaaaaaaa'));
    expect(first).toEqual(['owned by s-1']);
    expect(third).toEqual([]);
  });

  it('a call made before the hello lands waits for it and carries the session', async () => {
    const { hub, envelopes } = await connected([ok()]);
    const hello = Promise.withResolvers<void>();
    hub.pendingHello = hello.promise;
    const calling = hub.call('session.bye', {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(envelopes).toEqual([]);
    hub.sessionId = 's-aaaaaaaaaaaa';
    hello.resolve();
    await calling;
    expect(envelopes.map((e) => e.session)).toEqual(['s-aaaaaaaaaaaa']);
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
