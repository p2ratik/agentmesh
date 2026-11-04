import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script with no type declarations (the deploy job runs it as is).
import { judgeCertificate, requiresTls, smoke } from '../../deploy/auto-deploy/nats-smoke.mjs';

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

/** A local server that answers each connection with `greet`; resolves to its port. */
function serve(greet: (socket: Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(greet).listen(0, '127.0.0.1', () => {
      const address = server?.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('requiresTls', () => {
  it.each([
    ['INFO {"tls_required":true}', true],
    ['INFO {"tls_available":true}', true],
    ['INFO {"tls_required":false}', false],
    ['HTTP/1.1 400 Bad Request', null],
    ['INFO {not json}', null],
  ])('%s → %s', (line, expected) => {
    expect(requiresTls(line)).toBe(expected);
  });
});

describe('judgeCertificate', () => {
  const now = new Date('2026-11-04T00:00:00Z');
  it.each([
    ['Jan 13 00:00:00 2027 GMT', true, '70 more days'],
    ['Nov 17 00:00:00 2026 GMT', false, 'expires in 13 days'],
    ['Nov 01 00:00:00 2026 GMT', false, 'expires in -3 days'],
    ['not a date', false, 'expires in NaN days'],
  ])('%s → %s', (validTo, ok, words) => {
    const [verdict, message] = judgeCertificate(validTo, now);
    expect(verdict).toBe(ok);
    expect(message).toContain(words);
  });
});

describe('the NATS smoke test', () => {
  it('fails when NATS does not offer TLS', async () => {
    const port = await serve((socket) => socket.write('INFO {"tls_required":false}\r\n'));
    expect(await smoke('127.0.0.1', port)).toEqual({
      ok: false,
      message: `127.0.0.1:${port}: NATS does not offer TLS`,
    });
  });

  it('fails when something other than NATS answers', async () => {
    const port = await serve((socket) => socket.write('SSH-2.0-OpenSSH_9.6\r\n'));
    expect((await smoke('127.0.0.1', port)).message).toContain('something other than NATS');
  });

  it('fails when TLS is offered but no TLS server answers', async () => {
    const port = await serve((socket) => {
      socket.write('INFO {"tls_required":true}\r\n');
      socket.on('data', () => socket.destroy());
    });
    const result = await smoke('127.0.0.1', port);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('TLS failed');
  });

  it('fails when nothing answers in time', async () => {
    const port = await serve(() => undefined);
    expect((await smoke('127.0.0.1', port, new Date(), 200)).message).toContain('no answer');
  });

  it('fails when the port is closed', async () => {
    const port = await serve(() => undefined);
    server?.close();
    expect((await smoke('127.0.0.1', port)).message).toContain('cannot connect');
  });
});
