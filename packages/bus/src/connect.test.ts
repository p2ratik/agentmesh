import { createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { connectBus, generateUserKey, requiresTls, resolveSeed } from './connect';

/**
 * Just enough of a NATS server: it admits the first connect and drops it,
 * then refuses the next `refusals` connects the way nats-server does when
 * the auth callout says no, then admits again.
 */
async function fakeNats(refusals: number) {
  let connects = 0;
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    const n = connects++;
    const info = { server_id: 'fake', version: '2.15.1', proto: 1, max_payload: 1_048_576 };
    socket.write(`INFO ${JSON.stringify(info)}\r\n`);
    socket.on('data', (data) => {
      if (!data.toString().includes('PING')) return;
      if (n > 0 && n <= refusals) socket.end("-ERR 'Authorization Violation'\r\n");
      else socket.write('PONG\r\n');
    });
    if (n === 0) setTimeout(() => socket.destroy(), 200);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `nats://127.0.0.1:${port}`,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

describe('connect options', () => {
  it('requires TLS whenever a server URL says tls:// or wss://', () => {
    expect(requiresTls(['tls://hub.example.com:4222'])).toBe(true);
    expect(requiresTls(['nats://a:4222', ' TLS://b:4222'])).toBe(true);
    expect(requiresTls(['wss://hub.example.com'])).toBe(true);
    expect(requiresTls(['nats://hub.example.com:4222', 'localhost:4222'])).toBe(false);
  });

  it('generates a user key locally', () => {
    const key = generateUserKey();
    expect(key.publicKey).toMatch(/^U[A-Z2-7]{55}$/);
    expect(resolveSeed(key.seed)).toBe(key.seed);
  });

  // Under the auth callout, NATS refuses every connect while the hub restarts. nats.js gives up
  // after two refusals in a row unless told not to, which left agents offline for good.
  it('keeps reconnecting through refused reconnects', async () => {
    const fake = await fakeNats(3);
    const nc = await connectBus({ servers: [fake.url], name: 'refused-reconnects' });
    try {
      const reconnected = (async () => {
        for await (const s of nc.status()) if (s.type === 'reconnect') return true;
        return false;
      })();
      expect(await Promise.race([reconnected, nc.closed().then(() => false)])).toBe(true);
    } finally {
      await nc.close();
      fake.close();
    }
  }, 20_000);
});
