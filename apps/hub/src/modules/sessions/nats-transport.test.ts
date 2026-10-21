import type { NatsConnection } from '@agentmesh/bus';
import { createLogger } from '@agentmesh/common';
import type { MeshMessage } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { deliveryChunks, NatsSessionTransport } from './nats-transport';

/** The transport only reads ids and serializes; the rest of a message does not matter here. */
const messages = (n: number, body = 'x') =>
  Array.from({ length: n }, (_, i) => ({ id: `msg-${i}`, body }) as MeshMessage);

function fakeNats(ack: (ids: string[]) => string[]) {
  const requests: Array<{ subject: string; ids: string[]; noMux: boolean; reply: string }> = [];
  const nc = {
    info: { max_payload: 1024 * 1024 },
    async request(subject: string, data: string, opts: { noMux: boolean; reply: string }) {
      const ids = (JSON.parse(data).messages as MeshMessage[]).map((m) => m.id);
      requests.push({ subject, ids, noMux: opts.noMux, reply: opts.reply });
      return { json: () => ({ delivered: ack(ids) }) };
    },
  };
  return { nc: nc as unknown as NatsConnection, requests };
}

describe('NatsSessionTransport', () => {
  it('sends in order within the protocol limit and returns only sent ids the session acked', async () => {
    const { nc, requests } = fakeNats((ids) => [...ids.filter((id) => id !== 'msg-7'), 'msg-x']);
    const logger = createLogger('test', { level: 'silent', destination: 'stderr' });
    const transport = new NatsSessionTransport(nc, 'mesh', logger);
    const batch = messages(150);
    const acked = await transport.send('bob-agent', 'ses-1', batch);
    expect(requests.map((r) => r.ids.length)).toEqual([100, 50]);
    expect(requests[0]).toMatchObject({ subject: 'mesh.session.bob-agent.ses-1', noMux: true });
    expect(requests[0]?.reply).toMatch(/^mesh\.ack\.bob-agent\.[a-z0-9]+$/);
    expect(requests[0]?.reply).not.toBe(requests[1]?.reply);
    expect(acked).toEqual(batch.map((m) => m.id).filter((id) => id !== 'msg-7'));
  });

  it('keeps each delivery under the payload limit', () => {
    const big = messages(3, 'x'.repeat(1000));
    expect(deliveryChunks(big, 2500).map((c) => c.map((m) => m.id))).toEqual([
      ['msg-0', 'msg-1'],
      ['msg-2'],
    ]);
  });
});
