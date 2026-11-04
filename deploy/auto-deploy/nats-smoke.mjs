#!/usr/bin/env node
// Post-deploy smoke test from outside the server (docs/deploy.md#automatic-deploys): NATS answers
// on the public endpoint, requires TLS, and presents a certificate clients accept for the host
// name, with at least MIN_DAYS_LEFT to go. It is the path every agent connects through.
//
//   node deploy/auto-deploy/nats-smoke.mjs <host> [port]     exit 0 ok, 1 failed
//
// It follows `checkNatsTls` (apps/cli/src/setup/checks/nats-tls.ts), which `agentmesh doctor`
// runs, but needs no install: the deploy job runs it with the runner's node. It reads the greeting
// and, after the TLS handshake, the certificate; it sends no NATS command, so it never logs in.
import { connect as connectTcp, isIP } from 'node:net';
import { connect as connectTls } from 'node:tls';

const DAY_MS = 86_400_000;
const MIN_DAYS_LEFT = 14;
const TIMEOUT_MS = 10_000;
const MAX_INFO_BYTES = 64 * 1024;

/** Whether a NATS `INFO {…}` line requires TLS; null when the line is not one. Pure. */
export function requiresTls(line) {
  const json = /^INFO\s+(\{.*\})\s*$/.exec(line)?.[1];
  if (!json) return null;
  try {
    const info = JSON.parse(json);
    return Boolean(info.tls_required || info.tls_available);
  } catch {
    return null;
  }
}

/** The certificate's verdict: `[ok, message]`. Pure. */
export function judgeCertificate(validTo, now) {
  const daysLeft = Math.floor((new Date(validTo).getTime() - now.getTime()) / DAY_MS);
  // `!(>=)` also fails an unreadable date.
  if (!(daysLeft >= MIN_DAYS_LEFT)) {
    return [false, `the certificate expires in ${daysLeft} days; its renewal is failing`];
  }
  return [true, `NATS answers TLS; certificate valid for ${daysLeft} more days`];
}

/**
 * Upgrades the socket to TLS as every agent does: Node verifies the chain and the host name, and a
 * certificate clients would refuse fails with Node's reason (CERT_HAS_EXPIRED, …ALTNAME_INVALID).
 */
function upgrade(socket, host, now, done) {
  const secure = connectTls({ socket, ...(isIP(host) ? {} : { servername: host }) });
  secure.on('error', (err) => done(false, `TLS failed (${err.code || err.message})`));
  secure.on('secureConnect', () =>
    done(...judgeCertificate(secure.getPeerCertificate().valid_to, now)),
  );
  return secure;
}

/** Resolves to { ok, message }; the sockets are destroyed first. */
export function smoke(host, port, now = new Date(), timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connectTcp({ host, port });
    // Destroy the TLS socket once there is one: destroying the plain one under it first crashes
    // Node 24 on Windows at exit.
    let outer = socket;
    const done = (ok, message) => {
      clearTimeout(timer);
      outer.destroy();
      resolve({ ok, message: `${host}:${port}: ${message}` });
    };
    const timer = setTimeout(
      () => done(false, `no answer within ${timeoutMs / 1000} s`),
      timeoutMs,
    );
    socket.on('error', (err) => done(false, `cannot connect (${err.code || err.message})`));
    let received = '';
    const onData = (chunk) => {
      received += chunk.toString('latin1');
      const end = received.indexOf('\r\n');
      if (end < 0) {
        if (received.length > MAX_INFO_BYTES) done(false, 'something other than NATS answers');
        return;
      }
      socket.off('data', onData);
      const tls = requiresTls(received.slice(0, end));
      if (tls === null) return done(false, 'something other than NATS answers');
      if (!tls) return done(false, 'NATS does not offer TLS');
      outer = upgrade(socket, host, now, done);
    };
    socket.on('data', onData);
  });
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('nats-smoke.mjs')
) {
  const [host, port = '4222'] = process.argv.slice(2);
  if (!host) {
    console.error('usage: nats-smoke.mjs <host> [port]');
    process.exit(2);
  }
  const result = await smoke(host, Number(port));
  (result.ok ? console.log : console.error)(`nats-smoke: ${result.message}`);
  process.exitCode = result.ok ? 0 : 1;
}
