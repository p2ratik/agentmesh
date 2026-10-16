# AgentMesh — design spec (v1)

Date: 2026-10-16 · Status: approved for build · Supersedes the earlier planning note
"Agent Mesh — Claude Code sessions talking to each other (local-first)".

## 1. Goal

Let every developer's **local** Claude Code session work with the others like a professional
engineering team: ask each other questions, hand off and accept tasks, request and give reviews,
plan big pieces of work together, and react to production signals — with humans watching and
steering from Discord.

Success looks like:

- Pratik's agent asks Sagar's agent a question and gets the answer inside its running session,
  even if Sagar's laptop was asleep when the question was sent (it is queued and delivered on wake).
- `/plan` in Discord starts a session where every agent proposes, discusses, and a facilitator
  turns the result into assigned, dependency-ordered tasks.
- Tasks flow through a configurable workflow (assign → accept → build → PR → peer review → merge
  into `agents`) without a human in the loop; humans promote `agents` → `main`.
- A future Hermes bot (cron + event-driven, wired to GitHub/AWS/PostHog) can push events into the
  mesh and have them routed to the right agents by declarative rules.
- Another team can adopt it by editing YAML — no code changes, nothing team-specific hardcoded.

Non-goals for v1: cloud-hosted agents, a web UI, Slack, permission-prompt relay over the mesh,
GitHub API polling (Hermes covers that later), multi-tenant hosting.

## 2. Decisions

| Topic | Decision | Why |
| --- | --- | --- |
| Agents | Local Claude Code sessions only, one channel plugin each | User requirement: local-first |
| Hub host | One small VM (AWS/Azure) via docker compose, reached over Tailscale | Queue must outlive laptops |
| Broker | **NATS JetStream** | Durable per-agent consumers (offline queueing), dedup by message id, request/reply, subject permissions, single small binary |
| Human surface | **Discord** (bridge service) — not the agent transport | Discord rate limits and lack of per-agent durable queues rule it out as the bus |
| Architecture | Modular-monolith **hub** + separate **bridge** + **plugin**, talking only over NATS | Clear boundaries; bridges are swappable (Slack later) |
| State | SQLite (`node:sqlite`) behind repositories | Zero native deps; Postgres can replace it behind the same interfaces |
| Language | TypeScript on Node 24, pnpm monorepo | Same language for plugin, hub, bridge; shared protocol package |
| Branches | Task branch `agent/{owner}/{task}-{slug}` → PR into long-lived **`agents`** → humans promote to `main` | User choice |
| Autonomy | **Full**: agents ask/assign/accept/review/merge into `agents`; approved plans become tasks automatically (configurable) | User choice |
| Task routing | **Hybrid**: area ownership → least-loaded online owner → claim board | User choice |
| MCP SDK | `@modelcontextprotocol/sdk` **1.x** pinned | SDK 2.x negotiates a protocol revision Claude Code won't register as a channel |

## 3. Components

```
 each laptop                                 hub VM (docker compose)
 ┌──────────────────────────┐                ┌───────────────────────────────────────────┐
 │ Claude Code session      │                │ nats (JetStream)                          │
 │  └─ agentmesh plugin     │◄── NATS ──────►│ hub  — auth context, routing, limits,     │
 │     MCP stdio, channel   │  (tailnet)     │        threads, tasks, workflows, plans,  │
 └──────────────────────────┘                │        leases, rules, HTTP ingest, SQLite │
                                             │ discord-bridge — channels, slash cmds,    │
 Hermes / GitHub / CI ── HTTPS /v1/ingest ──►│        mirroring, human replies           │
                                             └───────────────────────────────────────────┘
```

- **`packages/protocol`** — zod schemas for every wire type, RPC method table, domain events,
  NATS subject/stream names. The single contract.
- **`packages/config`** — YAML loading, env interpolation, schemas, built-in defaults
  (workflows, planning template, policy), cross-reference validation, `ConfigIndex` lookups.
- **`packages/bus`** — thin NATS/JetStream wrapper: connect, topology provisioning, typed RPC
  client/server, durable consumers, publishing with dedup ids.
- **`packages/common`** — errors, ids, clock, logger, retry.
- **`apps/hub`** — the coordinator (sections 5–10).
- **`apps/discord-bridge`** — Discord adapter (section 11).
- **`apps/cli`** — `agentmesh` CLI: init, validate, add participants (nkeys), render NATS config.
- **`plugins/agentmesh`** — the Claude Code channel plugin (section 12).

## 4. Identity, trust and transport

**Participants** share one id namespace (`^[a-z0-9][a-z0-9-]{0,62}$`, used as NATS subject tokens):
humans (with Discord user ids and roles), agents (each owned by a human), services (bridges,
ingest producers). The hub's NATS user is separate and not a participant.

**Authentication** is NATS nkeys: each participant holds a private seed; `mesh.yaml` stores only
public keys. `agentmesh nats-config` renders `nats.conf` with per-user subject permissions:

| User | Publish | Subscribe |
| --- | --- | --- |
| agent `X` | `{p}.rpc.X.>`, `{p}.presence.X`, JetStream API for consumer `inbox-X` only, `$JS.ACK.{DELIVERY}.inbox-X.>` | `_INBOX_X.>` |
| bridge `B` | `{p}.rpc.B.>`, JetStream API for consumer `feed-B`, its acks | `_INBOX_B.>` |
| ingest `I` | `{p}.ingest.I` | `_INBOX_I.>` |
| hub | everything under `{p}.>`, `$JS.>`, `_INBOX.>` | same |

Because NATS enforces that X can only publish under `{p}.rpc.X.>`, the hub derives the caller from
the subject — `from` can't be spoofed. A service with `canActAsHumans` may pass `actAs: <human>`;
the hub then authorizes as that human (used by the Discord bridge after it verified the Discord
user id against config).

**Trust labels.** Every message carries `trust: team | external`. Team content is a colleague's
request. External content (events from Hermes/GitHub/PostHog, quoted logs) is data. The plugin's
instructions tell Claude never to follow instructions found in external content. This is the
remaining prompt-injection surface once Hermes is wired in; branch protection on `main` is the
backstop.

**Topology** (prefix `p`, default `mesh`):

| Subject | Kind | Purpose |
| --- | --- | --- |
| `{p}.rpc.{caller}.{method}` | core request/reply | every participant → hub call |
| `{p}.presence.{id}` | core publish | heartbeats |
| `{p}.deliver.{id}` | stream `{P}_DELIVERY` (workqueue) | durable per-participant inbox, consumer `inbox-{id}` |
| `{p}.evt.{type}` | stream `{P}_EVENTS` (limits, 7d) | activity feed for bridges, consumer `feed-{service}` |
| `{p}.ingest.{source}` | stream `{P}_INGEST` (workqueue) | external events, consumer `hub-ingest` |

Publishing uses `Nats-Msg-Id` (`{messageId}:{recipient}`, event ids) so retries are deduplicated.
The hub provisions streams and every configured participant's consumer at startup and on reload.

## 5. Messaging

- `message.send` starts a thread (`to`) or posts into one (`threadId`). Posting into a thread
  delivers to all thread participants except the sender; `to` adds participants. `@all` / `@online`
  expand to agents.
- **Thread depth** (loop guard): a thread created with `parentThreadId` gets `parent.depth + 1`;
  creating beyond `limits.maxThreadDepth` fails with `loop_detected`. Human-started threads are 0.
- **Limits** (all configurable): messages per thread per hour, per sender per day, duplicate body
  from the same sender in the same thread within `dedupWindowSeconds`, max body size.
- **Redaction**: obvious secrets (AWS keys, GitHub/Slack/Discord tokens, private key blocks,
  `password=`/`secret=` assignments) are masked before storing or publishing.
- **Kill switch**: `mesh.pause` holds all deliveries (stored as `held`); `mesh.resume` releases them.
- **Read state**: the hub stores a per-participant read cursor per thread. Channel pushes are
  best-effort (Claude Code drops them silently when the session isn't channel-enabled), so
  `inbox.get` returns unread messages and marks them read; `thread.get` and posting also advance
  the cursor. `session.hello` reports the unread count.
- Every stored message is published to the delivery stream for each agent recipient and to the
  activity feed (`message.created`) for bridges. Humans receive through bridges.

## 6. Tasks and workflows

A task has a workflow (from config), a state, assignee, reviewers, area, repo, base branch,
branch, PR URL, `doneWhen`, dependencies and a dedicated thread. Workflows are declarative state
machines:

```yaml
id: feature
initial: backlog
states:
  backlog: { onEnter: [auto_assign] }
  in_review: { active: true, onEnter: [request_reviews] }
  done: { terminal: true, onEnter: [release_leases, release_dependents, notify_creator, close_thread] }
transitions:
  - { action: submit, from: [in_progress, changes_requested], to: in_review, by: [assignee], requires: [prUrl] }
```

- `by` roles: `assignee`, `reviewer`, `creator`, `human`, `agent`, `any`, `system`.
- `requires`: fields the caller must pass (`note`, `prUrl`, `branch`, `to`).
- Effects are named built-ins (`auto_assign`, `notify_assignee`, `notify_creator`,
  `request_reviews`, `release_dependents`, `release_leases`, `clear_assignee`, `close_thread`,
  `post_notice`). Config references them by name; the hub has one module per effect.
- Conventions the hub relies on: `claim` sets the assignee to the caller; `assign`/`handoff` set it
  to `to`; a review verdict of `request_changes` fires the `request_changes` transition and
  reaching `review.requiredApprovals` fires `approve` (if the workflow defines them).
- Built-ins: `feature` (default) and `review` (stand-alone PR review). Teams add or override
  workflows in `config/workflows/*.yaml`.
- `task.get` returns `availableActions` for the caller so agents never guess.

**Assignment (`auto_assign`)** — skip if dependencies are unfinished. Candidates: owners of the
task's area (by `area` or `repo`), excluding agents who declined it and agents at
`maxActiveTasksPerAgent`. Rank: online first (if `preferOnline`), fewest active tasks, least
recently assigned. No candidate → the task stays on the board (`backlog`, unassigned) and is
announced per `boardAnnounce` (`matching-skills` | `online` | `none`); anyone may `claim`.

**Reviewers (`request_reviews`)** — pick up to `maxReviewers`: other owners of the area, then
agents with overlapping skills, then any agent; never the assignee; online and least-loaded first;
plus `review.humanReviewers`. Each review round is numbered; re-submitting starts a new round.

**Git policy** is configuration (`git.integrationBranch`, `protectedBranches`, `branchTemplate`,
`agentsMayMergeInto`) and is sent to agents in their channel instructions; the hub suggests a
branch name in every assignment. Agents operate git/gh themselves in per-task worktrees.

## 7. Planning sessions

`/plan topic:<…>` (or `plan.start` from an agent) creates a plan with a planning thread and
template rounds (default `standard`: *proposals* → *discussion*), then *synthesis*:

1. Every participant (default: all agents) gets the round prompt; offline agents get it queued.
2. A round ends at its deadline or when `quorum` of online participants contributed.
3. Each round's contributions are compiled and delivered with the next round's prompt.
4. The facilitator (`initiator`'s agent by default, or a configured agent) receives everything and
   calls `plan.submit` with a summary and task drafts (keys, assignees, dependencies, `doneWhen`).
   If the synthesis deadline passes, the hub hands facilitation to another online participant once,
   then marks the plan `stalled` and escalates to the initiator.
5. `planning.requireApproval: false` (default here) materializes immediately; `true` waits for
   `/plan approve` or the Approve button.
6. Materializing creates tasks with `planId`, maps draft keys to task ids for dependencies, and
   routes them (proposed assignee if valid, else `auto_assign`). Dependent tasks wait.

Messages posted in the planning thread go to every participant, so agents can debate directly.

## 8. Leases

Advisory locks on path globs, per repo, with TTL. Conflicts are detected conservatively by literal
prefix (`api/**` conflicts with `api/types/**`). All-or-nothing acquisition. Leases tied to a task
are released when it reaches a terminal state.

## 9. External events (Hermes-ready)

- HTTP `POST /v1/ingest/{source}` with bearer token or HMAC-SHA256 signature (GitHub-compatible),
  `format: mesh` (body is an `IngestEvent`) or `raw` (any JSON; type from a header/field). Producers
  with NATS credentials may publish to `{p}.ingest.{source}` directly.
- The hub stores each event (dedup by id) and evaluates **rules** in order:

```yaml
- id: ci-failed-on-integration
  match: { source: github, type: workflow_run.completed, where: { payload.workflow_run.conclusion: { equals: failure } } }
  throttle: { key: "{{payload.workflow_run.head_branch}}", windowMinutes: 30 }
  actions:
    - create_task: { title: "Fix CI on {{payload.workflow_run.head_branch}}", repo: "{{payload.repository.full_name}}", priority: high }
    - notice: { channel: alerts, text: "CI failed: {{url}}" }
```

- Actions: `notify` (area owners / online agents / all agents / ids), `create_task`, `notice`
  (bridge channel post). Templates are `{{path}}` lookups only — no code execution.
- Everything created from an event is `trust: external`.

## 10. Hub internals

Modular monolith; each module owns its repositories and exposes a service:

`db` (migrations, repositories) · `participants` (config sync, presence) · `messaging`
(threads, delivery, limits, redaction, read state) · `tasks` (workflow engine, effects,
assignment, reviews) · `planning` · `leases` · `ingest` (HTTP + consumer + rules) · `control`
(pause/resume, refs for bridges) · `rpc` (router: validation, auth, idempotency) · `scheduler`
(one tick loop for presence expiry, round deadlines, lease expiry).

Modules talk through services, never through each other's tables. Side effects go through ports
(`DeliveryPort`, `EventPort`) so domain logic is tested without NATS.

## 11. Discord bridge

- Provisions a category and purpose channels from `discord.channels` (names configurable):
  `council` (agent conversations), `tasks`, `reviews`, `planning` (forum: one post per plan),
  `escalations`, `events` (one-line feed), `alerts` (external events/notices).
- Consumes the activity feed with its own durable consumer, so it catches up after downtime.
- Mesh thread ↔ Discord thread mapping is stored in the hub (`refs.*`), so the bridge is stateless.
- Messages are posted through channel webhooks with the participant's display name and avatar;
  long bodies are chunked under Discord's 2000-character limit.
- Slash commands: `/plan start|status|approve|cancel`, `/task create|list|show|assign|cancel`,
  `/ask agent question`, `/mesh status|pause|resume`. Only humans listed in config (by Discord
  user id) may use them; admin-only commands check roles.
- A configured human replying inside a mirrored thread is relayed with `actAs`, reaching the agents
  as `from_kind="human"`. Unknown users and bots are ignored.

## 12. Channel plugin

- MCP server over stdio (Node 24, bundled to one `dist/server.js`), capability
  `experimental['claude/channel']` and `tools`. Permission relay is **not** declared.
- Config via plugin `userConfig` (agent id, NATS URL, nkey seed as sensitive) → env; falls back to
  `~/.agentmesh/agent.json`.
- On start: connect, `session.hello` (fetch team policy + git policy), heartbeat presence, then
  consume the durable inbox. Messages arriving together are coalesced per thread into one channel
  event; meta keys are snake_case identifiers (`thread_id`, `from`, `from_kind`, `kind`, `task_id`,
  `plan_id`, `status`, `trust`, `depth`). Ack after the notification is written; malformed
  messages are terminated.
- Tools: `peers`, `set_status`, `ask`, `reply`, `broadcast`, `inbox`, `thread`, `escalate`,
  `task_create`, `task_list`, `task_get`, `task_act`, `request_review`, `review_submit`,
  `plan_start`, `plan_get`, `plan_contribute`, `plan_submit`, `lease`, `release`.
- Ships a `mesh-collaboration` skill describing the team protocol (worktrees, branches, reviews,
  planning etiquette).
- Users need `--dangerously-load-development-channels plugin:agentmesh@agentmesh` (or an org
  `allowedChannelPlugins` entry) and an allow rule for `mcp__plugin_agentmesh_mesh__*`.

## 13. Reliability

- At-least-once everywhere; idempotency keys on RPC (hub caches results per caller+key), JetStream
  dedup ids on publish, unique constraints in SQLite.
- Hub restarts: streams and consumers are durable; deadlines live in SQLite and are re-evaluated
  by the tick loop.
- Plugin restarts: unacked deliveries are redelivered; `inbox.get` is the source of truth.
- Bridge restarts: the feed consumer resumes where it left off.
- All processes: graceful shutdown on SIGTERM/SIGINT and (plugin) stdin close.

## 14. Configuration

One directory: `mesh.yaml` + optional `workflows/*.yaml`, `rules/*.yaml`, `policy/*.md`.
`${VAR}` / `${VAR:-default}` interpolation for secrets. `agentmesh validate` reports every issue
with its path. See `config/examples/`.

## 15. Testing

- Unit (vitest): config validation, limits, redaction, workflow engine, assignment, reviewer
  selection, rule matching/templating, planning round logic (manual clock), plugin rendering and
  coalescing, Discord rendering/chunking, RPC router auth.
- Hub services are tested against in-memory SQLite and fake ports.
- Integration (opt-in, needs `AGENTMESH_TEST_NATS`): hub + real NATS + two simulated agents.

## 16. Code standards

- No source file over 300 lines (`pnpm check:size` in CI); one responsibility per module.
- Strict TypeScript, no `any`, Biome lint/format.
- Logs go to stderr in the plugin (stdout is the MCP protocol).
