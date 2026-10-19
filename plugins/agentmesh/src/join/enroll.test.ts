import { createServer, type Server } from 'node:net';
import { generateUserKey } from '@agentmesh/bus';
import { encodeInvite, type InvitePayload } from '@agentmesh/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { enroll } from './enroll';
import { readInvite } from './invite';

/** A fake NATS server that offers no TLS and records everything a client sends. */
function plaintextServer(): Promise<{ server: Server; port: number; received: string[] }> {
  const received: string[] = [];
  const server = createServer((socket) => {
    socket.on('data', (chunk) => received.push(chunk.toString('utf8')));
    socket.on('error', () => undefined);
    socket.write(
      'INFO {"server_id":"FAKE","version":"2.15.1","proto":1,"max_payload":1048576,"nonce":"bm9uY2U"}\r\n',
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : 0,
        received,
      });
    });
  });
}

let open: Server | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

describe('enroll', () => {
  it('sends nothing to a tls:// hub that does not offer TLS (stripped or misconfigured)', async () => {
    const fake = await plaintextServer();
    open = fake.server;
    const payload: InvitePayload = {
      v: 1,
      natsUrl: `tls://127.0.0.1:${fake.port}`,
      inviteId: 'inv-strip1',
      agentId: 'dana-agent',
      prefix: 'mesh',
      secret: `${'S'.repeat(42)}Q`,
    };
    const code = encodeInvite(payload);
    await expect(enroll(readInvite(code), code, generateUserKey().seed, 'test')).rejects.toThrow(
      /did not offer TLS/,
    );
    const sent = fake.received.join('');
    expect(sent).not.toContain(payload.secret);
    expect(sent).not.toContain(code);
    expect(sent).not.toContain('CONNECT');
  });
});
