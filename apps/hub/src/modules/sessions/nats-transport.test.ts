import type { NatsConnection } from '@agentmesh/bus';
import { createLogger } from '@agentmesh/common';
import type { MeshMessage } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { deliveryChunks, NatsSessionTransport } from './nats-transport';

/** The transport only reads ids, thread ids and bodies; the rest of a message does not matter here. */
const messages = (n: number, body = 'x') =>
  Array.from({ length: n }, (_, i) => ({ id: `msg-${i}`, threadId: 'thr-1', body }) as MeshMessage);

const logger = createLogger('test', { level: 'silent', destination: 'stderr' });

/** Acks what `ack` says; like nats.js, refuses a payload over max_payload. */
function fakeNats(ack: (ids: string[], call: number) => string[], maxPayload = 1024 * 1024) {
  const requests: Array<{
    subject: string;
    type: string;
    messages: MeshMessage[];
    bytes: number;
    noMux: boolean;
    reply: string;
  }> = [];
  const nc = {
    info: { max_payload: maxPayload },
    async request(subject: string, data: string, opts: { noMux: boolean; reply: string }) {
      const bytes = Buffer.byteLength(data);
      if (bytes > maxPayload) throw new Error('max_payload size exceeded');
      const { type, messages: sent = [] } = JSON.parse(data) as {
        type: string;
        messages?: MeshMessage[];
      };
      requests.push({ subject, type, messages: sent, bytes, noMux: opts.noMux, reply: opts.reply });
      const delivered = ack(
        sent.map((m) => m.id),
        requests.length,
      );
      return { json: () => ({ delivered }) };
    },
  };
  return { nc: nc as unknown as NatsConnection, requests };
}

describe('NatsSessionTransport', () => {
  it('sends in order within the protocol limit and returns only sent ids the session acked', async () => {
    const { nc, requests } = fakeNats((ids) => [...ids.filter((id) => id !== 'msg-7'), 'msg-x']);
    const transport = new NatsSessionTransport(nc, 'mesh', logger);
    const batch = messages(150);
    const acked = await transport.send('bob-agent', 'ses-1', batch);
    expect(requests.map((r) => r.messages.length)).toEqual([100, 50]);
    expect(requests[0]).toMatchObject({ subject: 'mesh.session.bob-agent.ses-1', noMux: true });
    expect(requests[0]?.reply).toMatch(/^mesh\.ack\.bob-agent\.[a-z0-9]+$/);
    expect(requests[0]?.reply).not.toBe(requests[1]?.reply);
    expect(acked).toEqual(batch.map((m) => m.id).filter((id) => id !== 'msg-7'));
  });

  it('keeps what earlier requests got through when a later one fails, and stops there', async () => {
    const { nc, requests } = fakeNats((ids, call) => {
      if (call === 2) throw new Error('timeout');
      return ids;
    });
    const transport = new NatsSessionTransport(nc, 'mesh', logger);
    const batch = messages(250);
    const acked = await transport.send('bob-agent', 'ses-1', batch);
    expect(acked).toEqual(batch.slice(0, 100).map((m) => m.id));
    expect(requests).toHaveLength(2);
  });

  it('throws when the first request fails', async () => {
    const { nc } = fakeNats(() => {
      throw new Error('no responders');
    });
    const transport = new NatsSessionTransport(nc, 'mesh', logger);
    await expect(transport.send('bob-agent', 'ses-1', messages(3))).rejects.toThrow(
      'no responders',
    );
  });

  it('clips a message larger than the payload limit and delivers it', async () => {
    const maxPayload = 3000;
    const { nc, requests } = fakeNats((ids) => ids, maxPayload);
    const transport = new NatsSessionTransport(nc, 'mesh', logger);
    const [small, big, last] = [...messages(1), ...messages(1, 'y'.repeat(5000)), ...messages(1)];
    const batch = [small, { ...big, id: 'msg-big' }, { ...last, id: 'msg-last' }] as MeshMessage[];
    expect(await transport.send('bob-agent', 'ses-1', batch)).toEqual([
      'msg-0',
      'msg-big',
      'msg-last',
    ]);
    expect(requests.every((r) => r.bytes <= maxPayload)).toBe(true);
    const clipped = requests.flatMap((r) => r.messages).find((m) => m.id === 'msg-big');
    expect(clipped?.body).toMatch(/^y+\n… _\(truncated: call thread\(thread_id: "thr-1"\)/);
  });

  it('sends an activation check as an acked request; a missing answer throws', async () => {
    const { nc, requests } = fakeNats(() => []);
    const transport = new NatsSessionTransport(nc, 'mesh', logger);
    await transport.check('bob-agent', 'ses-1', 'K7Q2ZP');
    expect(requests[0]).toMatchObject({
      subject: 'mesh.session.bob-agent.ses-1',
      type: 'check',
      noMux: true,
    });
    expect(requests[0]?.reply).toMatch(/^mesh\.ack\.bob-agent\./);
    const silent = fakeNats(() => {
      throw new Error('no responders');
    });
    const unanswered = new NatsSessionTransport(silent.nc, 'mesh', logger);
    await expect(unanswered.check('bob-agent', 'ses-1', 'K7Q2ZP')).rejects.toThrow('no responders');
  });

  it('keeps each delivery under the payload limit', () => {
    const big = messages(3, 'x'.repeat(1000));
    expect(deliveryChunks(big, 2500).map((c) => c.map((m) => m.id))).toEqual([
      ['msg-0', 'msg-1'],
      ['msg-2'],
    ]);
  });
});
