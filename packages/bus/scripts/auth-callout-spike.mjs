#!/usr/bin/env node
// Spike for task-3: how nats-server's auth callout behaves. See docs/specs/auth-callout-spike.md.
// Usage: node packages/bus/scripts/auth-callout-spike.mjs <path-to-nats-server> [--xkey]
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, nkeys } from '@nats-io/transport-node';

const [bin, ...flags] = process.argv.slice(2);
if (!bin) throw new Error('usage: auth-callout-spike.mjs <nats-server> [--xkey]');
const useXkey = flags.includes('--xkey');
const te = new TextEncoder();
const td = new TextDecoder();
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');

// ---- keys -------------------------------------------------------------------------------------
const issuer = nkeys.createAccount(); // signs every callout response and user JWT
const hub = nkeys.createUser(); // static user: bypasses the callout
const bridge = nkeys.createUser(); // static, least-privilege (like permissionsFor('bridge'))
const sysKey = nkeys.createUser(); // system account: KICK only
const curve = useXkey ? nkeys.createCurve() : null;
const port = 14_000 + Math.floor(Math.random() * 1000);

// ---- minimal account-mode config ----------------------------------------------------------------
// Every static user except the hub carries explicit permissions: a user without them gets `>`.
const dir = mkdtempSync(join(tmpdir(), 'callout-'));
const conf = `
listen: 127.0.0.1:${port}
jetstream { store_dir: "${join(dir, 'js').replaceAll('\\', '/')}" }
accounts {
  APP {
    jetstream: enabled
    users: [
      { nkey: ${hub.getPublicKey()} }
      { nkey: ${bridge.getPublicKey()},
        permissions: { publish: ["mesh.rpc.discord-bridge.>"], subscribe: ["_INBOX_discord-bridge.>"] } }
    ]
  }
  SYS {
    users: [
      { nkey: ${sysKey.getPublicKey()},
        permissions: { publish: ["$SYS.REQ.SERVER.*.KICK"], subscribe: ["_INBOX.>"] } }
    ]
  }
}
system_account: SYS
authorization {
  auth_callout {
    issuer: ${issuer.getPublicKey()}
    account: APP
    auth_users: [ ${hub.getPublicKey()}, ${bridge.getPublicKey()}, ${sysKey.getPublicKey()} ]
    ${curve ? `xkey: ${curve.getPublicKey()}` : ''}
  }
}
`;
writeFileSync(join(dir, 'nats.conf'), conf);
const server = spawn(bin, ['-c', join(dir, 'nats.conf')], { stdio: ['ignore', 'ignore', 'pipe'] });
process.on('exit', () => {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('nats-server not ready after 10s')), 10_000);
  server.stderr.on(
    'data',
    (d) => String(d).includes('Server is ready') && resolve(clearTimeout(timer)),
  );
  server.on('exit', (code) => reject(new Error(`nats-server exited ${code}`)));
});
const url = `nats://127.0.0.1:${port}`;

// ---- JWT helpers (ed25519-nkey JWTs are plain JWTs signed with the account nkey) ----------------
function signJwt(claims) {
  const head = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ed25519-nkey' })));
  const body = {
    jti: b64u(randomBytes(16)),
    iat: Math.floor(Date.now() / 1000),
    iss: issuer.getPublicKey(),
    ...claims,
  };
  const payload = b64u(te.encode(JSON.stringify(body)));
  return `${head}.${payload}.${b64u(issuer.sign(te.encode(`${head}.${payload}`)))}`;
}
const decodeJwt = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

// ---- the callout service, as the hub would run it -----------------------------------------------
const registry = new Map(); // agent public nkey -> agent id
const invites = new Map([['invite-secret', { agentId: 'dana-agent', used: false }]]);
const seen = []; // every request the server sent us
let verifySignatures = true;

const hubConn = await connect({ servers: url, authenticator: nkeyAuth(hub) });
const calloutSub = hubConn.subscribe('$SYS.REQ.USER.AUTH', {
  callback: (_err, msg) => {
    const serverXkey = msg.headers?.get('Nats-Server-Xkey');
    const raw = serverXkey && curve ? curve.open(msg.data, serverXkey) : msg.data;
    const req = decodeJwt(td.decode(raw)).nats;
    seen.push(req);
    const decision = decide(req);
    const resp = signJwt({
      sub: req.user_nkey,
      aud: req.server_id.id,
      nats: { type: 'authorization_response', version: 2, ...decision },
    });
    msg.respond(serverXkey && curve ? curve.seal(te.encode(resp), serverXkey) : te.encode(resp));
  },
});

function decide(req) {
  const { nkey, sig, auth_token: token } = req.connect_opts ?? {};
  if (!nkey || !sig) return { error: 'nkey required' };
  if (verifySignatures) {
    const ok = nkeys
      .fromPublic(nkey)
      .verify(te.encode(req.client_info.nonce), Buffer.from(sig, 'base64url'));
    if (!ok) return { error: 'bad signature' };
  }
  let agentId = registry.get(nkey);
  if (!agentId && token) {
    const invite = invites.get(token);
    if (!invite || invite.used) return { error: 'invalid invite' };
    invite.used = true;
    agentId = invite.agentId;
    registry.set(nkey, agentId);
  }
  if (!agentId) return { error: 'unknown key' };
  const userJwt = signJwt({
    sub: req.user_nkey,
    aud: 'APP', // target account name (no operator mode)
    name: agentId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nats: {
      type: 'user',
      version: 2,
      pub: { allow: [`mesh.rpc.${agentId}.>`] },
      sub: { allow: [`_INBOX_${agentId}.>`] },
    },
  });
  return { jwt: userJwt };
}

// ---- client helpers -----------------------------------------------------------------------------
function nkeyAuth(kp, { token, forgeWith } = {}) {
  return (nonce) => ({
    nkey: kp.getPublicKey(),
    sig: b64u((forgeWith ?? kp).sign(te.encode(nonce ?? ''))),
    ...(token ? { auth_token: token } : {}),
  });
}
async function tryConnect(label, opts) {
  try {
    const nc = await connect({ servers: url, reconnect: false, timeout: 3000, ...opts });
    return { label, connected: true, nc };
  } catch (e) {
    return { label, connected: false, error: e.message };
  }
}
const results = [];
const record = (q, answer, detail = '') => results.push({ q, answer, detail });

// (a) does the server verify the nkey signature before calling out?
const dana = nkeys.createUser();
const first = await tryConnect('invite', {
  authenticator: nkeyAuth(dana, { token: 'invite-secret' }),
});
const req0 = seen.at(-1);
record(
  'a: callout sees nkey+sig+nonce',
  Boolean(req0?.connect_opts?.sig && req0?.client_info?.nonce),
  JSON.stringify(Object.keys(req0?.connect_opts ?? {})),
);
record('a: valid invite connects', first.connected, first.error ?? '');

verifySignatures = false; // the callout trusts the server: does a forged signature get through?
const mallory = nkeys.createUser();
const forged = await tryConnect('forged', {
  authenticator: nkeyAuth(dana, { forgeWith: mallory }),
});
const calloutCalled = seen.at(-1) !== req0;
record(
  'a: forged sig reaches callout',
  calloutCalled,
  'true = server does NOT verify; callout must',
);
record('a: forged sig connects if callout skips verify', forged.connected, forged.error ?? '');
forged.nc?.close();
verifySignatures = true;
const forged2 = await tryConnect('forged-verified', {
  authenticator: nkeyAuth(dana, { forgeWith: mallory }),
});
record('a: forged sig with callout verify', forged2.connected, forged2.error ?? '');

// invite reuse
const reuse = await tryConnect('reuse', {
  authenticator: nkeyAuth(mallory, { token: 'invite-secret' }),
});
record('reuse of invite', reuse.connected, reuse.error ?? '');

// (c) the issued permissions are enforced
const nc = first.nc;
const errors = [];
(async () => {
  for await (const s of nc.status())
    if (s.type === 'error') errors.push(String(s.error?.message ?? s.error));
})();
nc.publish('mesh.rpc.dana-agent.ping');
nc.publish('mesh.rpc.someone-else.ping');
await nc.flush().catch(() => {});
await new Promise((r) => setTimeout(r, 300));
record(
  'c: publish outside allow-list refused',
  errors.some((e) => /permission/i.test(e)),
  errors.join(' | '),
);

// (b) the static hub user has JetStream in APP
const jsInfo = await hubConn
  .request('$JS.API.INFO', '', { timeout: 2000 })
  .then((m) => JSON.parse(td.decode(m.data)));
record(
  'b: hub has JetStream in APP',
  !jsInfo.error,
  jsInfo.error?.description ?? `streams=${jsInfo.streams}`,
);

// (d) $SYS kick by client id
const cid = req0.client_info.id;
const sys = await connect({ servers: url, authenticator: nkeyAuth(sysKey) });
const closed = nc.closed();
registry.delete(dana.getPublicKey()); // revoke first, so a reconnect is refused
const kick = await sys.request(
  `$SYS.REQ.SERVER.${req0.server_id.id}.KICK`,
  JSON.stringify({ cid }),
  { timeout: 2000 },
);
const kickReply = JSON.parse(td.decode(kick.data));
const wasClosed = await Promise.race([
  closed.then(() => true),
  new Promise((r) => setTimeout(() => r(false), 2000)),
]);
record('d: KICK by cid disconnects', wasClosed, JSON.stringify(kickReply).slice(0, 120));
const again = await tryConnect('revoked', { authenticator: nkeyAuth(dana) });
record('d: revoked key reconnect refused', !again.connected, again.error ?? '');
const sysPing = await sys
  .request('$SYS.REQ.SERVER.PING.CONNZ', '', { timeout: 1000 })
  .then(() => 'answered')
  .catch((e) => e.message);
record('d: restricted sys user can only KICK', sysPing !== 'answered', sysPing);

// static least-privilege users stay confined (a static user without permissions would get `>`)
const bridgeConn = await connect({ servers: url, authenticator: nkeyAuth(bridge) });
const bridgeErrors = [];
(async () => {
  for await (const s of bridgeConn.status())
    if (s.type === 'error') bridgeErrors.push(String(s.error?.message ?? s.error));
})();
bridgeConn.subscribe('$SYS.REQ.USER.AUTH');
bridgeConn.publish('mesh.rpc.dana-agent.ping');
await bridgeConn.flush().catch(() => {});
await new Promise((r) => setTimeout(r, 300));
record(
  'b: bridge cannot read auth requests or act as an agent',
  bridgeErrors.filter((e) => /permission/i.test(e)).length >= 2,
  bridgeErrors.join(' | '),
);
await bridgeConn.close();

// fail closed: callout down -> callout users refused, static users still connect
calloutSub.unsubscribe();
await hubConn.flush();
registry.set(dana.getPublicKey(), 'dana-agent');
const down = await tryConnect('callout-down', { authenticator: nkeyAuth(dana), timeout: 5000 });
record('callout down: callout user refused', !down.connected, down.error ?? '');
const hub2 = await tryConnect('hub-static', { authenticator: nkeyAuth(hub) });
record('callout down: static hub connects', hub2.connected, hub2.error ?? '');

for (const r of results)
  console.log(`${String(r.answer).padEnd(5)} | ${r.q}${r.detail ? `  (${r.detail})` : ''}`);
console.log(`xkey: ${useXkey ? 'on' : 'off'} · nats-server ${req0.server_id.version}`);
await Promise.allSettled([hubConn.close(), sys.close(), hub2.nc?.close()]);
