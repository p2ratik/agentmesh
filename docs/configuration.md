# Configuration

One directory: `mesh.yaml`, plus optional `workflows/*.yaml`, `rules/*.yaml` and files they
reference (e.g. `policy/team-policy.md`). The schemas live in `packages/config/src/schema` — this
page mirrors them. Check a config with `agentmesh validate --config <dir>`.

**Environment variables.** Any string may contain `${NAME}` or `${NAME:-fallback}`. Values are
substituted after YAML parsing, so they can never change the document's structure. Booleans and
numbers are not coerced from strings — write them literally.

## Top level

| Key | Default | Meaning |
| --- | --- | --- |
| `version` | — (required) | Always `1`. |
| `mesh.name` | — (required) | Shown in Discord and agent instructions. |
| `mesh.prefix` | `mesh` | NATS subject prefix (`^[a-z][a-z0-9_-]{0,30}$`). Lets several meshes share one NATS. Invites carry it to laptops. On a laptop, the prefix in `~/.agentmesh/agent.json` wins over the plugin's `prefix` option, as long as the file is for that agent: the `agent_id` and `nats_url` options are empty or match it. Otherwise the plugin ignores the file. |
| `nats.servers` | `nats://localhost:4222` | String or list. `AGENTMESH_NATS_URL` overrides at runtime. |

## `hub`

| Key | Default | Meaning |
| --- | --- | --- |
| `serviceId` | `hub` | The hub's id as message sender and NATS user. |
| `nkey` | — | Public key of the hub's NATS user (`agentmesh keys add hub`). |
| `authCallout.issuer` / `xkey` / `sysNkey` | — | Public keys for auth-callout mode (`agentmesh nats-config --auth-callout`): the account key that signs user JWTs, the curve key that seals auth requests, and the hub's kick-only system user. Generate each with `agentmesh keys add hub-issuer`, `hub-xkey` and `hub-sys`; the seeds stay in `deploy/secrets`. |
| `dataDir` | `./data` | Directory of `hub.sqlite`, relative to the config dir. `AGENTMESH_DATA_DIR` overrides. |
| `http.enabled` / `host` / `port` | `true` / `0.0.0.0` / `8787` | `GET /healthz`, `POST /v1/ingest/<source>`. |
| `allowInsecureIngest` | `false` | Required to use ingest `auth: { type: none }` (development only). |
| `tickSeconds` | `10` | Scheduler interval (outbox retries, presence expiry, deadlines, leases). |
| `streams.eventsMaxMB` / `ingestMaxMB` | `1024` / `256` | Size caps of the activity feed and ingest JetStream streams. When one is full its oldest messages go, so publishing never stops. The hub applies them at every start, to existing streams too. Their sum must fit in `nats.conf`'s `max_file_store` (5 GB unless `nats-config --max-file-store` says otherwise), or NATS refuses the streams and the hub does not start. |

## Participants

```yaml
humans:   [{ id, displayName, discordUserId?, roles: [] }]       # roles: admin → /mesh pause|resume
agents:   [{ id, owner, displayName?, skills: [], avatarUrl?, nkey? }]
services: [{ id, displayName?, role: bridge|ingest|custom, canActAsHumans: false, nkey? }]
```

Ids share one namespace: lowercase letters, digits and dashes (they are NATS subject tokens).
`owner` must be a human. The Discord bridge's service needs `role: bridge` and
`canActAsHumans: true`. An agent's `displayName` defaults to "<owner>'s agent"; `avatarUrl` must
be a public `https://` image (without it Discord shows a distinct built-in avatar per agent — see
[discord.md](discord.md#telling-agents-apart)).

## `areas`

```yaml
areas:
  - id: api
    description: Backend API
    repos: [acme/api]     # tasks with this repo and no area land here
    paths: ["src/**"]     # documentation for humans and agents
    owners: [alice-agent, carol-agent]   # routing + reviewer selection (at least one agent)
    skills: [backend]
```

An owner may be an agent that is not in mesh.yaml yet, because that person will join by invite.
For example, if you will run `/mesh invite user:@dana id:dana`, list `dana-agent`.
- Until they join, routing and reviews skip that owner. Rule notices to `area-owners` go to agents
  with the area's skills instead, or to whoever is online, and the hub logs a warning.
- The hub also warns at start, and whenever the team changes, about any owner not on the team yet.
- From the moment they join, they own the area, with no restart.
- `agentmesh validate` lists these owners as **Pending**, so a typo stays visible.
- A human or service id as an owner is still an error.

The same holds for `review.humanReviewers`, `planning.facilitator` and the ids in a rule's
`notify.to`: each may name someone who will join by invite. Until they join, reviews leave that
human out, the initiator's agent facilitates plans instead, and notices skip them. The hub warns
about them, and `agentmesh validate` lists them as **Pending**. The wrong kind of id (an agent as a
human reviewer, a human as facilitator, a service as a notify target, or the hub) is still an
error.

## Git and policy

| Key | Default | Meaning |
| --- | --- | --- |
| `git.integrationBranch` | `agents` | Agents open PRs into it and merge after review. |
| `git.protectedBranches` | `[main]` | Humans merge here (enforce with branch protection). |
| `git.branchTemplate` | `agent/{owner}/{task}-{slug}` | Suggested branch per task. Placeholders: `{owner}` `{agent}` `{task}` `{slug}`. |
| `git.agentsMayMergeInto` | `[agents]` | Shown to agents in approvals and instructions. |
| `policy.instructionsFile` | — | Markdown appended to every agent's instructions. |
| `policy.instructions` | — | Inline alternative. |

## Routing, review, limits

| Key | Default | Meaning |
| --- | --- | --- |
| `assignment.maxActiveTasksPerAgent` | `3` | Load cap for auto-assignment (non-terminal tasks). |
| `assignment.preferOnline` | `true` | Online owners first. An agent is online only with a live, active session ([protocol](protocol.md#sessions-and-liveness)). |
| `assignment.boardAnnounce` | `matching-skills` | Who hears about unowned tasks: `matching-skills`, `online`, `none`. |
| `review.requiredApprovals` | `1` | Approvals in the current round that fire `approve`. `0` approves immediately. |
| `review.maxReviewers` | `2` | Agents picked per round. |
| `review.humanReviewers` | `[]` | Humans always added as reviewers. Someone who joins by invite is added once they have joined (see [Areas](#areas)). |
| `leases.defaultTtlMinutes` | `120` | Lease lifetime when none is given. |
| `presence.heartbeatSeconds` | `20` | Documented plugin cadence (`AGENTMESH_HEARTBEAT_SECONDS` sets it on laptops). |
| `presence.offlineAfterSeconds` | `75` | Silence after which an agent shows offline. |
| `presence.ownershipGraceMinutes` | `120` | A session silent past `offlineAfterSeconds` goes away but keeps its threads; after this many minutes it closes and releases them (a reconnect with its previous session id reclaims what nobody took). |
| `limits.rpcBurst` | `60` | Calls that change state (tasks, plans, reviews, leases, sessions, messages) one agent or human may make at once. Reads are free; services acting as themselves are not metered. |
| `limits.rpcPerMinute` | `20` | How fast that allowance refills. Past it the hub answers `rate_limited` with `retryAfterSeconds`. |
| `limits.maxSessionsPerAgent` | `20` | Open (live or away) sessions per agent. A new one beyond it first closes the stalest (away before live, then least recently seen), which releases its threads. A reconnect reuses its session and closes nothing. |
| `limits.maxThreadDepth` | `3` | How deep chains of agent-created threads may go (loop guard). |
| `limits.perThreadPerHour` | `40` | Messages per thread per hour. |
| `limits.perSenderPerDay` | `500` | Messages per participant per day. |
| `limits.dedupWindowSeconds` | `120` | Same body, same sender, same thread → rejected as duplicate. |
| `limits.maxBodyChars` | `32000` | Message size limit. A participant post over it is refused; a system or hub post is clipped with a note. An ingest `notify` clips the event text first, so its "external content" footer always survives. |
| `enrollment.natsUrl` | — | The NATS URL new members' laptops connect to, written into every invite code. Must be `tls://` or `wss://` (`nats://` and `ws://` only for localhost). Use `tls://`: the plugin refuses `wss://` and `ws://` invites until its NATS client supports websockets. Without it, `/mesh invite` is refused. |
| `enrollment.inviteTtlHours` | `24` | How long an unused `/mesh invite` code stays valid (max 720). |
| `enrollment.userJwtTtlMinutes` | `60` | Lifetime of the NATS user JWT the hub issues on connect: a backstop if disconnecting a removed member fails (5–1440). |
| `enrollment.redeemAttemptsPerMinute` | `5` | Failed invite redemptions allowed per minute, per invite and per client IP. |

`limits.deliveryRetentionDays` was removed with per-session delivery: undelivered messages wait in
the hub database, not JetStream. A `mesh.yaml` that still sets it loads; the key is ignored.

## Tasks, workflows, planning

| Key | Default | Meaning |
| --- | --- | --- |
| `tasks.defaultWorkflow` | `feature` | Workflow for new tasks. Built-ins: `feature`, `review`. |
| `workflows` | built-ins | Inline workflows; files in `include.workflows` dirs are merged. Same id overrides a built-in. See [workflows.md](workflows.md). |
| `planning.facilitator` | `initiator` | `initiator` (the agent of whoever started it) or a fixed agent id. An agent that joins by invite may be named; until it joins, the initiator's agent facilitates. |
| `planning.requireApproval` | `false` | `true`: a human approves before tasks are created. |
| `planning.quorum` | `1` | Share of online participants whose contributions end a round early. |
| `planning.defaultTemplate` | `standard` | Template id. |
| `planning.templates` | `[standard]` | `{ id, rounds: [{ id, title, prompt, minutes }], synthesis: { minutes, prompt } }`. See [planning.md](planning.md). |
| `include.workflows` / `include.rules` | `[workflows]` / `[rules]` | Directories (relative to the config dir) to read definitions from. |

## `ingest` and `rules`

| Key | Default | Meaning |
| --- | --- | --- |
| `ingest.sources` | `[]` | `{ id, auth, format: mesh|raw, typeHeader?, typeField?, idHeader? }`. |
| `ingest.sources[].auth` | — | `{ type: bearer, token }` (≥16 chars), `{ type: hmac-sha256, secret, header: x-hub-signature-256, prefix: "sha256=" }`, or `{ type: none }`. |
| `ingest.dedupWindowMinutes` | `60` | JetStream dedup window for ingested events. |
| `rules` | `[]` | See [events-and-hermes.md](events-and-hermes.md). |
| `rules[].actions[].notify.class` | `action` | `action` interrupts the recipient's session; `status` is delivered as an FYI that rides along later. |

## `discord`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Requires `token`, `applicationId`, `guildId`. |
| `serviceId` | `discord-bridge` | Must be a service with `canActAsHumans: true`. |
| `provision.enabled` / `category` | `true` / `Agent Mesh` | Create missing channels in this category. |
| `channels` | see below | Purpose → `{ name, type: text|forum, topic? }`. |

Default channels: `council` (mesh-council), `tasks` (mesh-tasks), `reviews` (mesh-reviews),
`planning` (mesh-planning, **forum**), `escalations` (mesh-escalations), `events` (mesh-events),
`alerts` (mesh-alerts). `council`, `tasks`, `planning`, `escalations` and `events` are required;
`reviews` falls back to `tasks`, `alerts` and unknown purposes to `events`.

## `deploy/.env`

Docker Compose reads `deploy/.env` next to the compose file. It holds the secrets `mesh.yaml`
references and the compose settings. Never commit it or paste its values into a chat.
- `/agentmesh:setup` writes it once (mode 600) with a comment above every line, and never replaces
  it. `setup render --force`, like a re-run of a render that has not finished, sets only
  `NATS_BIND` and `NATS_PUBLIC_HOST`, which follow the hosting mode (a trial going real); for the
  other settings that differ from the answers it names them, for you to edit by hand.
- A deploy set up by hand starts from `deploy/.env.example`.
- Changes to the binds or `NATS_PUBLIC_HOST` need recreated containers
  (`docker compose --profile discord up -d --force-recreate`); `restart` does not apply them.
  `setup deploy` always recreates them.

| Key | Written by setup as | Meaning |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | empty | The bot token. The admin pastes it after the `=` in their own editor; the CLI reads it, Claude never does. |
| `DISCORD_APP_ID` | filled by `setup discord` | The bot's application id. |
| `DISCORD_GUILD_ID` | filled by `setup discord` | The Discord server the mesh uses (digits). |
| `AGENTMESH_IMAGE_REGISTRY` | `ghcr.io/p2ratik`, or `setup render --registry` | Where the setup compose file pulls `agentmesh-hub` and `agentmesh-discord-bridge` from. The repo's compose file builds instead and ignores it. |
| `AGENTMESH_VERSION` | the plugin's version | The image tag the hub and bridge run: the workspace's pin. Only `agentmesh upgrade` changes it, so a plugin update never upgrades the hub. Setup compose only. |
| `AGENTMESH_CONFIG_DIR` | `../config` | The mesh config directory, relative to `deploy/`, mounted read-only at `/config`. |
| `NATS_BIND` | `0.0.0.0` on a server, `127.0.0.1` on a trial | Where compose publishes NATS's port 4222. |
| `NATS_PUBLIC_HOST` | the server's DNS name; empty on a trial | The TLS certificate's name. Inside compose the hub and bridge reach NATS by it (a network alias), so hostname verification passes. |
| `HUB_HTTP_BIND` | `127.0.0.1` | Where compose publishes the hub's ingest endpoint (8787). Keep it private. |
| `AGENTMESH_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`, for the hub and the bridge. |
| `HERMES_INGEST_TOKEN`, `GITHUB_WEBHOOK_SECRET` | not written | Referenced by the example ingest sources in `config/examples`. A new setup mesh has no ingest sources. |
