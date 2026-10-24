import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { z } from 'zod';
import { NATS_PORT } from '../defaults';
import type { CheckResult } from './result';

const DAY_MS = 86_400_000;
/** Let's Encrypt renews 30 days ahead, so under 14 days left means renewal keeps failing. */
const MIN_DAYS_LEFT = 14;
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
/** A NATS INFO line is a few hundred bytes; anything longer is not NATS. */
const MAX_INFO_BYTES = 64 * 1024;

const NatsInfo = z.object({
  tls_required: z.boolean().optional(),
  tls_available: z.boolean().optional(),
});

/** `21 Jan 2027`, in UTC. */
function day(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Judges the certificate NATS presented. Pure. */
export function classifyCert(
  c: { authorized: boolean; authorizationError?: string; validTo: string },
  host: string,
  now: Date,
): CheckResult {
  const where = `${host}:${NATS_PORT}`;
  if (!c.authorized) {
    return {
      ok: false,
      label: `${where} has a TLS certificate clients refuse`,
      detail: `${c.authorizationError ?? 'not trusted'}. Run setup host again to get a Let's Encrypt certificate for ${host}.`,
    };
  }
  const validTo = new Date(c.validTo);
  const daysLeft = Math.floor((validTo.getTime() - now.getTime()) / DAY_MS);
  // `!(>=)` also fails an unreadable date.
  if (!(daysLeft >= MIN_DAYS_LEFT)) {
    return {
      ok: false,
      label: `${where} certificate expires on ${day(validTo)}`,
      detail:
        'Its renewal is failing. On the server, `sudo certbot renew` shows why; ' +
        "Let's Encrypt needs port 80 open.",
    };
  }
  return { ok: true, label: `${where} answers TLS (cert valid to ${day(validTo)})` };
}

/** Whether a NATS `INFO {…}` line offers TLS; null when the line is not one. */
function offersTls(line: string): boolean | null {
  const json = /^INFO\s+(\{.*\})\s*$/.exec(line)?.[1];
  if (!json) return null;
  try {
    const info = NatsInfo.safeParse(JSON.parse(json));
    return info.success ? Boolean(info.data.tls_required || info.data.tls_available) : null;
  } catch {
    return null;
  }
}

/**
 * Connects to NATS the way a client does: read the plain-text INFO line, then upgrade the
 * same socket to TLS with the host's name, and judge the certificate. Gives up after
 * `timeoutMs`; the sockets are destroyed before it resolves.
 */
export function checkNatsTls(
  host: string,
  port: number,
  now: Date,
  timeoutMs = 5_000,
): Promise<CheckResult> {
  return new Promise((resolve) => {
    const socket = connectTcp({ host, port });
    // The TLS socket once there is one: destroying it destroys the socket under it, while
    // destroying the plain socket first crashes Node 24 on Windows at exit.
    let outer: Socket = socket;
    const done = (result: CheckResult) => {
      clearTimeout(timer);
      outer.destroy();
      resolve(result);
    };
    const fail = (detail: string) =>
      done({ ok: false, label: `${host}:${port} does not answer TLS`, detail });
    const timer = setTimeout(
      () =>
        fail(
          `No answer within ${timeoutMs / 1000} s. Check that port ${port} is open to the internet ` +
            'and that the nats container is running.',
        ),
      timeoutMs,
    );

    socket.on('error', (error) => fail(`${error.message}. Check that port ${port} is open.`));
    let received = '';
    const onData = (chunk: Buffer) => {
      received += chunk.toString('latin1');
      const end = received.indexOf('\r\n');
      if (end < 0) {
        if (received.length > MAX_INFO_BYTES) fail(`Something other than NATS answers on ${port}.`);
        return;
      }
      socket.off('data', onData);
      const tls = offersTls(received.slice(0, end));
      if (tls === null) return fail(`Something other than NATS answers on ${port}.`);
      if (!tls) {
        return fail(
          'NATS does not offer TLS. Run setup deploy again: the nats.conf it copies requires TLS.',
        );
      }
      // Nothing is ever sent over this connection: it only reads the certificate, and one
      // that fails verification (chain or host name) fails the check with Node's reason.
      const secure = connectTls({ socket, servername: host, rejectUnauthorized: false });
      outer = secure;
      secure.on('error', (error) => fail(error.message));
      secure.on('secureConnect', () => {
        // Node sets a code string here, though the types say Error.
        const reason: unknown = secure.authorizationError;
        done(
          classifyCert(
            {
              authorized: secure.authorized,
              ...(reason ? { authorizationError: String(reason) } : {}),
              validTo: secure.getPeerCertificate().valid_to,
            },
            host,
            now,
          ),
        );
      });
    };
    socket.on('data', onData);
  });
}
