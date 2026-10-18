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
  the key, with `withheld = 1` and no result. A retry with the same key, sent after the first call
  completes, fails with `conflict` and does not replay the secret. Two calls with the same key that
  overlap in flight can both run, because the key is only recorded afterwards. Reserving the key
  before running the handler is a follow-up for the enrollment module (task-6).
- **Residual risk:** if the response is lost in transit, the secret is gone and the caller has to
  start over, for example by cancelling and re-issuing the invite. This is accepted on purpose:
  losing an invite is better than storing it.

## Invite codes

*Contracts only so far. The hub enrollment and auth-callout work (plan-1) builds on these rules,
and ADR-0005 will give the full threat model.*

An invite code (`/mesh invite`) is a **bearer token**. Whoever presents it first enrolls, so the
Discord id on the invite only labels the member: redeeming the code does not prove that Discord
identity.

- **Threat: a TLS-stripping attacker on the network path.** The secret travels in the NATS
  CONNECT. With a `nats://` URL, the client upgrades to TLS only if the server's INFO asks for it,
  and an attacker can rewrite that INFO. They can then read the secret, relay the nonce signature
  and enroll as the new member.
  **Mitigation:** the protocol accepts `tls://` and `wss://` invite URLs only. Plaintext
  `nats://` and `ws://` are allowed for localhost only, and URLs carrying credentials are refused.
- **Threat: the code at rest.** **Mitigation:** the hub stores only sha256(secret), the result is
  never written to the idempotency cache (`cacheResponse: false`), and decode errors never echo
  the code.
- **Threat: guessing.** **Mitigation:** 256-bit secret, single use, a short TTL
  (`enrollment.inviteTtlHours`), and rate-limited redemption (`enrollment.redeemAttemptsPerMinute`).
- **Threat: other services reading the member list.** **Mitigation:** `enrollment.list` is
  restricted to services with the `bridge` role.
