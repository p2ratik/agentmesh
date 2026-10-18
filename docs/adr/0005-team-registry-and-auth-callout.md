# ADR 0005 — A team registry in the hub and a NATS auth callout

**Status:** proposed · 2026-10-19. This is an architecture change, so team policy needs Aheen's
approval before it counts as accepted.

## Context

Until now every participant was a static NATS user in `nats.conf`, rendered from `mesh.yaml`.
Adding a member meant several manual steps:
- an admin edits YAML;
- the admin generates the member's seed and sends it privately;
- the admin re-renders `nats.conf`, reloads NATS and restarts the hub.

That works for one trusted team but not for a product, and every hand-off of a seed is a chance to
leak it. The roadmap (CLAUDE.md) asks for `/mesh invite` → `/agentmesh:join <code>` with no YAML
edit, no restart, and a key that never leaves the member's laptop.

## Decision

- **A team registry in the hub database.**
  - The `enrollment` module owns `enrollment_invites` and `enrollment_members`.
  - The hub merges active members into its config index (`withMembers`), so a new agent resolves at
    once.
  - `mesh.yaml` keeps policy, workflows, rules and areas, and stays a valid way to list members.
    It wins on any collision of id, Discord id or key.
- **NATS auth callout for agents.**
  - `nats-config --auth-callout` renders account mode: the hub and every mesh.yaml service stay
    static `auth_users` with explicit permissions, so the hub can never lock itself out.
  - Every agent connect goes to the hub's callout. The callout verifies the nkey signature, admits
    known keys or redeems an invite, and issues a short-lived user JWT with the same
    `permissionsFor()` scopes as before.
  - The callout fails closed.
- **Invites are redeemed in the callout, not over HTTPS.**
  - The laptop generates its nkey and connects to the already public TLS NATS port, with the
    invite code as `auth_token`.
  - That adds no new public surface (the hub's HTTP port stays on localhost) and needs no
    anonymous NATS user. The nkey signature over the server nonce proves the laptop holds the key.
  - Fallback if this proves wrong: an HTTPS enrollment endpoint on the ingest server.
- **JWTs are signed with `@nats-io/nkeys`**, which the CLI already ships. There is no JWT library:
  a NATS JWT is about ten lines on top of nkeys, and the integration test checks it against a real
  nats-server.
- **Removal** revokes the member, then kicks their live connections through a kick-only
  system-account user. The JWT's `exp` (`enrollment.userJwtTtlMinutes`) is the backstop.

## Consequences

- **Adding a member** takes one Discord command and one plugin command; the seed never leaves the
  laptop. **Removing one** takes effect within seconds, and within the JWT TTL at worst.
- **The hub becomes part of the authentication path.**
  - While it is down, no agent can connect or reconnect, though agents already connected keep
    working until their JWT expires.
  - Static users (hub, bridge, ingest) are unaffected.
- **The callout is the only nkey signature check,** because nats-server forwards signatures
  unchecked in this mode. It is security-critical code and needs Avishek's review; see
  `docs/security.md`.
- **Three new hub secrets** (the issuer account seed, the xkey seed and the kick-only sys seed) live
  in `deploy/secrets/`. `mesh.yaml` and `nats.conf` hold only their public keys.
- **Static mode is unchanged.** Without `--auth-callout` the static config is byte-for-byte the
  same, so existing deploys keep working until they switch.

## Migrating a live deploy

1. **Update the hub** to a build with migration 003 (the registry). It runs on start and keeps
   existing data.
2. **Generate the callout keys:** `agentmesh keys add hub-issuer|hub-xkey|hub-sys --secrets
   deploy/secrets`. Set `enrollment.natsUrl` to the public `tls://host:4222`.
3. **Render the config:** `agentmesh nats-config --tls --auth-callout`. Existing mesh.yaml agents
   keep their keys; the callout admits them.
4. **Copy the files to the VM:** `config/`, `deploy/nats/nats.conf` and the three new seeds. Never
   copy `deploy/.env`.
5. **Restart NATS, then the hub** (`docker compose restart nats hub`). The accounts change, so a
   reload is not enough. Check that the hub's log shows no seed errors and that an existing agent
   reconnects.
6. **Roll back** by rendering without `--auth-callout` and restarting both. Members enrolled through
   invites then cannot connect until they are added to mesh.yaml.
