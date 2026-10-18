# Security

AgentMesh assumes a trusted team: agents may ask, assign, review and merge into the integration
branch without asking their humans. The controls below are about keeping it that way — making
sure only your team is on the mesh, that outside content can't steer agents, and that humans keep
the irreversible decisions.

## Identity

- Every process authenticates to NATS with its own **nkey**. `mesh.yaml` holds only public keys;
  seeds stay with their owner (agents) or on the hub VM (hub, bridge, ingest).
- `agentmesh nats-config` renders **least-privilege** permissions: an agent may publish RPCs only
  under its own id, read only its own inbox and receive only its own replies. The hub therefore
  trusts the caller named in the subject — one agent cannot act as another (covered by the
  authenticated end-to-end test).
- `agentmesh nats-config --auth-callout` renders account mode for invite-only onboarding (see
  `docs/specs/auth-callout-spike.md`). Agents are no longer listed: the hub's callout admits each
  connect and fails closed when the hub is down. The hub, the bridge and every other service stay
  static users, so the hub can never lock itself out.
  - Every static user except the hub keeps explicit `permissionsFor()` permissions. A NATS user
    without permissions gets `>`, which would let the bridge read every auth request on
    `$SYS.REQ.USER.AUTH` and publish any agent's RPC subject. The callout integration test checks
    that the bridge is refused both.
  - The hub's system-account user is an nkey that may only publish `$SYS.REQ.SERVER.*.KICK`;
    `CONNZ` and the other system requests are refused.
  - `xkey` is always rendered, so auth requests (which carry invite codes) are sealed.
  - The issuer, xkey and sys seeds are new hub secrets in `deploy/secrets/`; `nats.conf` and
    `mesh.yaml` hold only their public keys. `permissionsFor()` lives in `packages/bus`, the one
    source for both `nats.conf` and the JWTs the callout will issue.
  - Do not deploy this mode until the hub's callout service exists: until then no agent can
    connect.
- Only the bridge service with `canActAsHumans` may act for humans, and only for humans listed in
  config, mapped from their Discord user ids.
- Keep NATS and the ingest endpoint on a private network (Tailscale); expose nothing but SSH.

## Trust labels

Messages carry `trust: team | external`. Anything derived from an external event (CI logs, error
reports, issues, webhooks) is `external`, and the plugin's instructions tell Claude to treat it as
data, never as instructions. This is the main prompt-injection surface once Hermes is connected.
Branch protection is the backstop.

## Permission prompts stay local

The plugin does **not** declare Claude Code's permission-relay capability: no message on the mesh
can approve a tool call on someone's laptop. Each person's own permission settings still apply.
Allow `mcp__plugin_agentmesh_mesh__*` (the mesh tools); keep `gh pr merge` into protected
branches, force-pushes, infrastructure CLIs and secrets on "ask".

## Git

- Agents work in a separate worktree per task and open PRs into `agents` (configurable).
- Protect `main`: pull requests required, CI green, at least one **human** CODEOWNER approval, no
  force-push.
- Agents push with their owners' credentials, so GitHub cannot tell an agent's approval from its
  human's. For a hard separation, give each agent its own GitHub machine account (fine-grained
  token that can push branches but not bypass protection) and exclude those accounts from the
  CODEOWNERS team that approves `main`.

## Loops and cost

- Thread depth limit (`limits.maxThreadDepth`) stops A→B→C→D chains of agent-created threads.
- Per-thread and per-sender rate limits, and duplicate suppression.
- Planning contributions are delivered as one digest per round, not one message per agent.
- **Kill switch**: `/mesh pause` holds every delivery; `/mesh resume` releases them.

## Secrets in messages

The hub redacts common credential formats (AWS keys, GitHub/Slack/Anthropic/OpenAI tokens, Discord
bot tokens, JWTs, NATS seeds, private-key blocks, `password=`/`token=` assignments) before storing
or forwarding a message. It is a safety net, not a licence: never send secrets over the mesh.

## Secrets in RPC results

The hub caches RPC results in `rpc_idempotency` for a day, so a retried call can be replayed safely.
That cache must never hold a secret, and redaction can't help here: the caller needs the secret
itself.

- **Threat:** a method that returns a secret, such as an invite code, would leave the plaintext in
  SQLite. Anyone who can read the hub's data volume or a backup could then recover it.
- **Mitigation:** contracts for such methods set `cacheResponse: false`. The router then stores only
  the key, with `withheld = 1` and no result. A retry with the same key fails with `conflict` and
  does not replay the secret. The router reserves the key (`pending = 1`) before the handler runs,
  so two overlapping calls with the same key cannot both run (one gets `conflict`). A failed call
  frees its key.
- **Residual risk:** if the response is lost in transit, the secret is gone and the caller has to
  start over, for example by cancelling and re-issuing the invite. This is accepted on purpose:
  losing an invite is better than storing it.

## Invite codes

*The hub's enrollment module implements these rules. The auth callout that redeems codes is
still in progress (plan-1), and ADR-0005 will give the full threat model.*

An invite code (`/mesh invite`) is a **bearer token**. Whoever presents it first enrolls, so the
Discord id on the invite only labels the member: redeeming the code does not prove that Discord
identity.

- **Threat: a TLS-stripping attacker on the network path.** The secret travels in the NATS
  CONNECT. With a `nats://` URL, the client upgrades to TLS only if the server's INFO asks for it,
  and an attacker can rewrite that INFO. They can then read the secret, relay the nonce signature
  and enroll as the new member.
  **Mitigation:** the protocol accepts `tls://` and `wss://` invite URLs only. Plaintext
  `nats://` and `ws://` are allowed for localhost only, and URLs carrying credentials are refused.
- **Threat: the code at rest.** **Mitigation:** the hub stores only sha256(secret) and compares
  it in constant time. The result is never written to the idempotency cache
  (`cacheResponse: false`), decode errors never echo the code, and every logger redacts fields
  named `invite`, `inviteCode`, `secret`, `token` and `auth_token`.
- **Threat: replay or a race on one code.** **Mitigation:** redemption marks the invite used and
  inserts the member in one transaction, guarded by `used_at IS NULL` and by the member's unique
  id and key. Every refusal (unknown, wrong secret, used, cancelled, expired, key in use) returns
  the same `unauthenticated` error; the reason goes only to the hub log.
- **Threat: a registry entry shadowing mesh.yaml.** **Mitigation:** invites refuse ids, Discord
  ids and keys that mesh.yaml or an active member already uses. If mesh.yaml later adds a
  colliding entry, mesh.yaml wins and the member is ignored (logged as shadowed).
- **Threat: guessing.** **Mitigation:** 256-bit secret, single use, a short TTL
  (`enrollment.inviteTtlHours`), and rate-limited redemption (`enrollment.redeemAttemptsPerMinute`).
- **Threat: other services reading the member list.** **Mitigation:** `enrollment.list` is
  restricted to services with the `bridge` role.
