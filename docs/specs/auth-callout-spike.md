# Spike: NATS auth callout (task-3, plan-1)

This spike checks how nats-server **2.15.1** behaves with `auth_callout` before we build the hub's
callout service (task-9) and account-mode `nats.conf` (task-5).

Reproduce it with `node packages/bus/scripts/auth-callout-spike.mjs <path-to-nats-server> [--xkey]`.
The script starts a throwaway server and runs a callout service the way the hub would. It then
prints one line per check. It ran on 2026-10-18 on Windows with the official 2.15.1 release
(SHA256 checked), with and without xkey, and all 14 checks gave the same result both ways. A
security audit then revised this note; see the end.

Refusals show up to the client as either `Authorization Violation` or a connection reset
(`ECONNRESET`), depending on timing. Tests must not depend on the error text.

## Answers

### (a) Does the server verify the client's nkey signature before calling out?

**No.** The server forwards `connect_opts.nkey`, `connect_opts.sig` (base64url) and
`client_info.nonce` to the callout without checking them. With signature checking turned off in
the callout, a client presenting someone else's public key with a forged signature **connected**.

**The callout must verify the signature itself**, and do it before anything else:
`nkeys.fromPublic(nkey).verify(utf8(nonce), base64url(sig))`. `fromPublic` also checks the key's
checksum. Once the callout verifies, a forged signature is refused. This is the single most
important rule for task-9.

`connect_opts.auth_token` carries the invite code alongside the nkey, so the join flow works with
one connect. The server does nothing with the token. Single use is entirely the callout's job:
task-9 must redeem atomically in the database.

### (b) The account-mode config

```
jetstream { store_dir: "/data/jetstream" }
accounts {
  APP {
    jetstream: enabled
    users: [
      { nkey: <hub U…> }                                     # the hub keeps pub/sub ">"
      { nkey: <bridge U…>,  permissions: <permissionsFor('bridge')> }
      { nkey: <ingest U…>,  permissions: <permissionsFor('ingest')> }
    ]
  }
  SYS {
    users: [
      { nkey: <hub-sys U…>,
        permissions: { publish: ["$SYS.REQ.SERVER.*.KICK"], subscribe: ["_INBOX.>"] } }
    ]
  }
}
system_account: SYS
authorization {
  auth_callout {
    issuer: <account A… public key>   # the hub signs responses and user JWTs with this seed
    account: APP                      # the callout service runs on the hub's APP connection
    auth_users: [ <hub U…>, <bridge U…>, <ingest U…>, <hub-sys U…> ]  # static: bypass the callout
    xkey: <curve X… public key>       # required, see below
  }
}
```

- **Every static user except the hub must carry explicit `permissions`.** A user without them gets
  publish and subscribe on `>` in its account. A bridge left like that could subscribe to
  `$SYS.REQ.USER.AUTH`, read every auth request, and publish `mesh.rpc.<any-agent>.*`. Render
  `permissionsFor()` for each user, exactly as the static config does today.
  - **Verified:** a bridge with permissions is refused both the auth subject and another agent's
    RPC subject.
  - task-5 needs an integration test for this.
- **Only the hub may subscribe to `$SYS.REQ.USER.AUTH`.** That falls out of the permissions above.
- **All services in mesh.yaml stay static `auth_users`** (bridge, ingest, custom). The callout
  only ever decides about agents.
- **`auth_users` accepts nkey public keys**, so every static user keeps its nkey.
- **The system-account user is an nkey that may only publish KICK.**
  - **Verified:** it can kick, and a `CONNZ` request is refused.
  - `nats.conf` stays public-key only, and the hub's sys seed lives in `deploy/secrets/` with its
    other seeds.
  - If task-9 needs `CONNZ` (see d), add exactly that subject.
- **New secrets for `deploy/secrets/`:** the issuer account seed, the xkey seed and the hub-sys
  seed. They never go into `mesh.yaml` or `nats.conf`.
- **xkey is required in the rendered config.** With it, the request arrives sealed with the
  server's curve key (header `Nats-Server-Xkey`), and the response must be sealed back to that key.
  That hides invite tokens on the auth subject.
  - xkey does not prove who sent the request, since anyone can seal to a public key. The callout
    must also verify the request JWT's signature, with `iss` equal to `server_id.id`, before it
    trusts `client_info.host` for rate limits.

### (c) The JWTs the callout must issue

Both JWTs are plain ed25519 JWTs: header `{"typ":"JWT","alg":"ed25519-nkey"}`, signed by the
issuer account keypair. **No `@nats-io/jwt` dependency is needed.** `nkeys` is already exported by
`@nats-io/transport-node` (`import { nkeys } from '@nats-io/transport-node'`), and signing a JWT is
about ten lines. task-9 must unit-test the encoder and have avishek-agent review it.

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
- The permissions are enforced: a publish outside `pub.allow` gets a permissions violation.
- The spike's allow-lists are only illustrative. task-9 derives them from
  `permissionsFor({ id, kind: 'agent' })`, which also covers presence and the JetStream consumer
  API.
- **`exp`** gives the `enrollment.userJwtTtlMinutes` backstop.
- **Never log a decoded auth request or its `auth_token`.** The `error` text in a response ends up
  in the nats-server log, so it must never contain the token.

### (d) Does `$SYS` KICK by client id work?

**Yes.** Send a request to `$SYS.REQ.SERVER.<server_id>.KICK` with `{"cid": <client_info.id>}` from
the system-account connection, and the client is disconnected at once. If the member is revoked
first, the client's automatic reconnect goes back through the callout and is refused.

An agent can hold **more than one connection**: two sessions, or a restart overlapping the old one.
Also, `server_id` changes when nats-server restarts. So for task-9:
- **revoke first;**
- **then kick every connection of that agent:** either keep a set of `{server_id, cid}` per agent,
  pruned on disconnect, or at removal time query `CONNZ` for connections named after the agent
  (this needs `CONNZ` added to the sys user);
- **the JWT `exp` covers anything missed.**

With more than one NATS server, KICK has to go to the server that holds each connection.

### Failing closed

If no callout service is subscribed, connections that need the callout are refused, while static
`auth_users` (hub, bridge) still connect. The hub can never lock itself out, and a crashed hub
admits nobody new.

## Consequences for the plan

- **task-9:**
  - verify the nkey signature first, and the request JWT's issuer too;
  - take the invite from `auth_token` and redeem it atomically;
  - issue JWTs with `nkeys` (drop `@nats-io/jwt`), using permissions from `permissionsFor`;
  - kick every connection of a removed agent;
  - never log tokens;
  - open one extra connection as the restricted sys nkey.
- **task-5:**
  - render the config above with `--auth-callout`, with explicit permissions on every static user
    except the hub;
  - make xkey and the sys user nkeys;
  - generate the issuer, xkey and sys seeds with `pnpm mesh keys`;
  - add an integration test that the bridge cannot subscribe to the auth subject.
- **task-8:** the threat note must say that the callout is the only signature check, cover the
  static-user permissions, and cover the sys user's scope.

## Revision after the security audit

An audit standing in for Avishek's review changed three things in the first version of this note:
- **The static users:** that version gave them no permissions, which would have granted them `>`.
- **The sys user:** it used a plaintext password with full system rights.
- **xkey:** it was called optional.

The script now uses a restricted bridge and a KICK-only sys nkey, and it checks both.
