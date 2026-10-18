# Spike: NATS auth callout (task-3, plan-1)

This spike checks how nats-server **2.15.1** behaves with `auth_callout` before we build the hub's
callout service (task-9) and account-mode `nats.conf` (task-5).

Reproduce it with `node packages/bus/scripts/auth-callout-spike.mjs <path-to-nats-server> [--xkey]`.
The script starts a throwaway server and runs a callout service the way the hub would. It then
prints one line per check. It ran on 2026-10-18 on Windows with the official 2.15.1 release
(SHA256 checked), with and without xkey, and every check came out the same both ways.

## Answers

### (a) Does the server verify the client's nkey signature before calling out?

**No.** The server forwards `connect_opts.nkey`, `connect_opts.sig` (base64url) and
`client_info.nonce` to the callout without checking them. With signature checking turned off in
the callout, a client presenting someone else's public key with a forged signature **connected**.

**The callout must verify the signature itself**, and do it before anything else:
`nkeys.fromPublic(nkey).verify(utf8(nonce), base64url(sig))`. Once it does, a forged signature is
refused. This is the single most important rule for task-9.

`connect_opts.auth_token` carries the invite code alongside the nkey, so the join flow works with
one connect: the laptop presents its new nkey, a signature and `token=<invite>`. Reusing a
redeemed invite is refused.

### (b) The minimal account-mode config

```
jetstream { store_dir: "/data/jetstream" }
accounts {
  APP { jetstream: enabled, users: [ { nkey: <hub U…> }, { nkey: <bridge U…> } ] }
  SYS { users: [ { user: sys, password: "<secret>" } ] }   # the hub's KICK connection only
}
system_account: SYS
authorization {
  auth_callout {
    issuer: <account A… public key>   # the hub signs responses and user JWTs with this seed
    account: APP                      # the callout service runs in APP, so the hub needs one connection
    auth_users: [ <hub U…>, <bridge U…>, sys ]   # static users; they bypass the callout
    xkey: <curve X… public key>       # optional: encrypts requests/responses (recommended)
  }
}
```

- **`auth_users` accepts nkey public keys**, so the hub and bridge keep their current nkeys.
- **The callout can run inside `APP`**, the same account the mesh uses. The hub's existing
  connection subscribes to `$SYS.REQ.USER.AUTH` there. JetStream works for the hub in `APP`.
- **KICK needs a system-account connection** (see d). That makes it one extra hub connection, as
  `sys`.
- **New secrets for `deploy/secrets/`:** the issuer account seed, the xkey seed and the `sys`
  password. They never go into `mesh.yaml`.
- **xkey** is optional. With it, the request arrives sealed with the server's curve key (header
  `Nats-Server-Xkey`), and the response must be sealed back to that key. Keep it on: it hides
  invite tokens from anything else that can read the auth subject.

### (c) The JWTs the callout must issue

Both JWTs are plain ed25519 JWTs: header `{"typ":"JWT","alg":"ed25519-nkey"}`, signed by the
issuer account keypair. **No `@nats-io/jwt` dependency is needed.** `nkeys` is already exported by
`@nats-io/transport-node` (`import { nkeys } from '@nats-io/transport-node'`), and signing a JWT is
about ten lines. This removes risk (c) from the plan.

The authorization **response**:

```
{ jti, iat, iss: <issuer A…>, sub: <request.user_nkey>, aud: <request.server_id.id>,
  nats: { type: "authorization_response", version: 2, jwt: <user JWT> | error: "<reason>" } }
```

The **user JWT** embedded in it:

```
{ jti, iat, exp, iss: <issuer A…>, sub: <request.user_nkey>, aud: "APP", name: <agent id>,
  nats: { type: "user", version: 2, pub: { allow: [...] }, sub: { allow: [...] } } }
```

- **`sub` is the server-generated `user_nkey`**, not the client's own nkey.
- **`aud` is the target account name** (no operator mode).
- The permissions are enforced: a publish outside `pub.allow` gets a permissions violation, so
  `permissionsFor()` maps directly into `pub`/`sub`.
- **`exp`** gives the `enrollment.userJwtTtlMinutes` backstop.

### (d) Does `$SYS` KICK by client id work?

**Yes.** Send a request to `$SYS.REQ.SERVER.<server_id>.KICK` with `{"cid": <client_info.id>}` from
a system-account connection, and the client is disconnected at once.

The hub must therefore remember `server_id.id` and `client_info.id` from each auth request, keyed
by agent. If the member is revoked first, the client's automatic reconnect goes back through the
callout and is refused.

With more than one NATS server, KICK has to go to the server that holds the connection, which the
stored `server_id` identifies. We run one server today.

### Failing closed

If no callout service is subscribed, connections that need the callout are refused with
`Authorization Violation`, while static `auth_users` (hub, bridge) still connect. The hub can never
lock itself out, and a crashed hub admits nobody new.

## Consequences for the plan

- **task-9:** verify the signature first, take the invite from `auth_token`, issue JWTs with
  `nkeys` and drop `@nats-io/jwt`, record `{server_id, cid}` per agent for KICK, and open one
  extra `sys` connection.
- **task-5:** render the config above with `--auth-callout`, add the issuer and xkey public keys
  to the hub config, and generate the three new secrets with `pnpm mesh keys`.
- **task-8:** the threat note must say the server does not verify nkey signatures under
  callout, and that the callout is the only check.
