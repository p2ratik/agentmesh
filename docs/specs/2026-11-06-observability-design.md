# Observability: a timeline of how AgentMesh behaves, on the hub and on every laptop

Status: approved for phase 1 (2026-11-06).

**Phases (decided by Pratik, to launch quickly):**

- **Phase 1, release 0.7.0:** data collection and the timeline. That is sections 4–7, the config in
  section 9 (`observability.*`), and the security notes in section 10 for the telemetry RPC and the
  timeline.
- **Phase 2, later:** metrics, Grafana, Alertmanager and the dead man's switch (section 8, plus the
  deploy and `.env` parts of section 9).

Until phase 2, the operator checks the timeline directly.

**Disclosure (decided by Pratik):** he has already told the team, and he will broadcast again once
monitoring is set up. So no in-product notice. `docs/security.md` and the plugin README still state what
is collected and what never is.

## 1. Why

Staging QA of 0.6.0 found five bugs. The two worst ones (the window's guard refused Claude Code's real
`SendMessage` shape) happened entirely on a laptop. The hub logged "relay forwarded", which looked like
success, while every relay failed. Monitoring that only watches the server would have shown green.

The operator (Pratik, who develops AgentMesh and owns the server) wants to see how AgentMesh behaves on
every teammate's machine, and to be alerted when it misbehaves. He expects "unexpected behaviours" he
can't name in advance. So the system has to keep a detailed event history that he can hand to an agent
(Claude), and the agent has to be able to work out what happened from it quickly.

## 2. Goals, non-goals, anti-goals

**Goals**

- A per-agent, per-session **timeline** of AgentMesh behaviour, covering what the hub saw and what each
  plugin saw. For example: activations and their result, every mesh tool call and its outcome, each
  message's delivery journey, relay outcomes, guard decisions, disconnects and reconnects, and versions.
- **Agents can read it.** One command or tool call returns a timeline an agent can reason over.
- **Dashboards** for trends, and **alerts** for the failures that matter (section 8).
- **The operator only.** Nobody else on the team can read timelines, dashboards or alerts until the
  operator adds them (section 3).

**Non-goals**

- Tracing Claude's reasoning or what it did with a message. The plugin can see that it handed a message
  to Claude Code; it can't see whether Claude read it.
- A general log platform (Loki or ELK). The hub's own event store is enough for a team of 5–15.
- Monitoring teammates' laptops beyond AgentMesh (CPU, other apps).

**Anti-goals** (failure even if it technically works)

- Collecting message text, prompts, code, file contents, tool output, or anything a teammate typed.
  Pratik: "I don't need their message, it's invasion of privacy."
- Teammates or other admins seeing the timeline before the operator grants it.
- Alerts going to a channel everyone reads (`#mesh-alerts` is readable by the whole Discord server).
- Monitoring that goes silent when the hub, or the whole VM, is down.
- Telemetry that ever slows down or breaks mesh work. It is best-effort and never blocks a tool, a
  push or a heartbeat.

## 3. Who can see what (decided by Pratik)

- **Viewers** are a config list of humans: `observability.viewers`. For this team it's `[pratik]`. Later,
  someone who joins AgentMesh development can be added without a code change.
- The hub enforces it. A timeline call from an agent whose owner isn't a viewer is refused with
  `forbidden`. Aheen and every other teammate are refused, admins included.
- Grafana, Prometheus and Alertmanager run on the operator's VM and are reachable only through his SSH
  tunnel. NSG rule `allow-ssh-admin` already limits SSH to his IP.
- Alerts go to a destination only the operator sees: a private Discord channel's webhook, or email.
  The destination is configured in the deployment's `.env`, never in git.
- **Teammates are told.** `docs/security.md`, the join note and the plugin README say plainly what is
  collected and what never is. Teammates can't read the timeline, but they know it exists.

## 4. What is recorded (decided by Pratik, the field lists are my call)

The privacy line, decided by Pratik: ids, counts, outcomes, error codes, timings and versions only. Never
message text, prompts, code, file contents, tool output or command lines.

Every event has `at` (ISO time), `agent`, `session` (hub session id, if any), `source` (`hub`, `plugin`,
`guard` or `hook`) and `kind`. The rest is fixed per kind and schema-checked (zod in
`packages/protocol`). There is no free-text field. Wherever an event says why, it uses a reason code from
a fixed list.

**From each plugin** (on the teammate's laptop):

| Kind | Fields |
| --- | --- |
| `connected` | plugin version, Claude Code version (MCP `clientInfo`), OS, arch, Node version, `meshWindow`, `pull` |
| `nats` | `disconnect`, `reconnect` or `error` (error code only) |
| `activation` | phase: `check_sent`, `activated`, `refused`, `failed`, `renewed`, `renewal_fallback`, `deactivated`; mode; reason code |
| `tool` | tool name, `ok` or error code, duration ms, ids it named (thread, task, plan; no text) |
| `delivery` | message id, thread id, stage: `received`, `pushed`, `push_failed`, `deduped`, `held`; ms since received |
| `relay` | message id, thread id, stage: `pushed`, `claimed`, `expired`, `denied` + guard reason code |
| `guard` | tool name, decision `deny` or `ask`, reason code (see below) |
| `hook` | `note_shown` (unread count), `pointer_labelled`, `window_labelled`, `not_mesh_labelled`, `error` |
| `dropped` | how many events the local buffer had to drop (a gap marker) |

**Guard reason codes** are new. Today the guard denies with one generic sentence. To be debuggable it
must say which check failed:

- `send.unknown_key` (with the key name, if it matches `^[A-Za-z_]{1,40}$`)
- `send.bad_address`
- `send.alias_mismatch`
- `send.content_mismatch`
- `send.no_record`
- `send.claim_failed`
- `list_agents`
- `path.outside_worktree`
- `command.not_listed`

Plus the existing cases the builder finds in `guard/decide.ts`. This alone would have pinpointed both
guard bugs in seconds.

**From the hub** (its own events, written to the same store):

| Kind | Fields |
| --- | --- |
| `session` | `opened`, `hello`, `away`, `live`, `closed`, `evicted`, `taken_over` (with replaced session and thread ids) |
| `delivery` | message id, thread id, session, stage: `sent`, `acked`, `failed` (code), `no_session` |
| `relay` | message id, thread id, window session, `sent`, then `forwarded` or not with reason |
| `orphan` | thread id: `recorded`, `escalated`, `settled` |
| `rpc` | method, caller, error code (errors only; successful calls are counted in metrics, not stored) |
| `auth` | callout `denied` with reason code, connect budget hit (security signal) |

## 5. How events travel (my call)

- **Recorder in the plugin.** The MCP server keeps a capped in-memory buffer (default 500 events).
- **Guard and hook** run as separate short processes, so they append events to a capped
  `events-<pid>.jsonl` file in the plugin data folder (built-ins only, at most about 256 KB, rotated).
  The MCP server collects and deletes those files.
- **Shipping.** Every heartbeat interval (20 s) the plugin sends what it has with a new RPC,
  `telemetry.report { events: [...] }`, at most 100 events per call. An error-kind event triggers an
  early send. Events leave the buffer only after the hub acknowledges them.
- **Why a separate RPC and not the heartbeat message.** The heartbeat is a fire-and-forget NATS publish
  with no acknowledgement, and events must not be lost silently. The RPC goes through the hub's router
  like every other call: the NATS subject proves the caller, so a plugin can only report events for its
  own agent id. It is schema-checked, size-capped and rate-limited.
- **Offline.** The buffer holds events while the laptop is disconnected and sends them on reconnect.
  When the cap is hit, the oldest are dropped and a `dropped` event records how many. Gaps are visible,
  never silent.
- **Never in the way.** Recording is synchronous and cheap. Shipping failures are retried on the next
  beat and never surface to Claude or the human.
- **Older peers.** A 0.6.x plugin sends nothing, and its timeline shows hub-side events only. A 0.7.0
  plugin talking to an older hub gets "unknown method" once and stops reporting for that process.

## 6. The hub's event store (my call)

- An `events` table in the hub's SQLite (migration 009), indexed by `(agent, at)`, `(thread, at)` and
  `(session, at)`. The hub writes its own events and the reported ones through one repository.
- **Retention:** `observability.retentionDays` (default 14). The scheduler tick prunes older rows, as
  it does for closed sessions today.
- **Volume:** a 5–15 person team produces well under 100k events a day. If it's ever needed, the
  builder may batch inserts.
- **The hub clock is the reference.** Each reported event keeps the plugin's `at`, plus the hub's
  `received_at`, so laptop clock skew is visible.

## 7. Reading the timeline (my call)

The tool and the CLI read the event store through a new RPC, `observe.timeline`. It takes an agent, a
session, a thread or `all`; `since` and `until`; optional kinds; and a limit. The hub refuses it unless the
caller's owner is in `observability.viewers`. Grafana reads only Prometheus metrics, never the event
store. There is no HTTP read path for events, so the viewers check has nothing to bypass.

1. **Mesh tool `timeline`**, in every plugin, described as "operator only". The operator asks any of
   his Claude sessions, "show me Aheen's mesh timeline for the last two hours". For anyone else the hub
   refuses it.
2. **CLI** `agentmesh timeline --agent <id> [--session <id>] [--thread thr-N] [--since 2h]`. It uses the
   operator's own agent credentials from `~/.agentmesh/agent.json`, the same as the plugin.
3. **Grafana** for trends only (section 8). An alert links the exact `agentmesh timeline …` command to
   run.

The output is plain text, one line per event, grouped into a delivery's journey where it can be: hub sent
→ plugin received → pushed to Claude. A header line gives the versions. For example:

```
aheen-agent · plugin 0.7.0 · Claude Code 2.1.319 · win32 · last 2h
10:02:11  connected      s-ab12 (mesh window)
10:02:19  activate       ok · push · guard 0.7.0
10:40:05  delivery       thr-31 msg-…  hub sent → plugin got it → pushed to Claude ✓ 0.4s
11:05:02  relay          thr-33 → pointer pushed → guard denied: send.unknown_key (summary) ✗
11:20:44  disconnected   no heartbeat (hub) · NATS connection lost (plugin)
11:58:10  reconnected    after 37 min · session renewed → re-activated itself ✓
```

The formatter is a pure function, unit-tested, in the hub or in `packages/protocol`, so the tool and the
CLI print the same thing.

## 8. Metrics, dashboards and alerts (Prometheus and Grafana, Pratik's suggestion; details my call)

- **Hub metrics.** The hub serves Prometheus metrics on its HTTP server at `/metrics`. Like `/healthz`,
  that server is bound to `127.0.0.1` on the host; Prometheus reaches it over the compose network. The
  exposition is hand-written: counters and gauges with labels, about 100 lines. That avoids a new
  dependency (CLAUDE.md: prefer the standard library).
  - Gauges: sessions by liveness and kind (window, active, pull, private) per agent; mesh windows live
    per agent; outbox pending and the oldest pending age; open orphan decisions.
  - Counters (by agent where it makes sense):
    - deliveries by stage, and the relay funnel (sent, pushed, claimed, expired, denied);
    - guard decisions by reason;
    - activations by phase;
    - tool errors by tool and code;
    - RPC errors by method and code;
    - auth denials;
    - telemetry events received and dropped.
  - Process metrics: uptime, event loop lag, memory.
- **A `monitoring` compose profile** on the VM, alongside `discord`:
  - Prometheus, which scrapes the hub, NATS and the host;
  - Alertmanager;
  - Grafana, with dashboards and the data source provisioned from the repo;
  - `node-exporter`, for disk, memory and CPU;
  - `prometheus-nats-exporter`, reading NATS's monitoring port, which stays inside the compose network.

  No new public port. Grafana is opened through `ssh -L 3000:localhost:3000`. The images are pinned to
  versions and the containers hardened like the hub's.
- **Dashboards** (provisioned JSON in `deploy/monitoring/grafana/`):
  1. Mesh overview: who is online, windows per agent, sessions.
  2. Delivery and relay funnels.
  3. Errors: by agent, tool and reason.
  4. Hub and host health.
- **Alert rules** (`deploy/monitoring/rules/*.yml`, thresholds editable there):
  - `HubDown`: health or scrape failing for 2 minutes.
  - `RelaysNotForwarded`: relay pointers pushed but not claimed within their 10-minute life. This is
    the 0.6.0 guard bug's signature.
  - `GuardDenialSpike`: denials by reason above a threshold in 10 minutes.
  - `DeliveriesFailing`: delivery `failed` or `push_failed` above 0 for 5 minutes, or the outbox's
    oldest pending item older than 5 minutes.
  - `ActivationFailures`: `failed` or `refused` activations above a threshold per hour.
  - `AuthDenialBurst`: callout denials spike (security).
  - `TelemetryDropped`: plugins dropping events.
  - `DiskFilling`: under 15% free on the data volume.
- **Routing.** Alertmanager sends to the operator's private Discord webhook (Alertmanager's Discord
  receiver) or to email, from `ALERT_DISCORD_WEBHOOK_URL` / SMTP settings in `deploy/.env`. Alerts never
  pass through the hub or the bridge, so they still arrive when those are down. Each alert's text names
  the agent and the `agentmesh timeline` command.
- **A dead man's switch.** Prometheus's always-firing `Watchdog` alert pings an external check-in URL
  every minute (`DEADMAN_PING_URL`, optional; healthchecks.io's free plan or any equivalent). If the
  pings stop because the VM, Prometheus or Alertmanager died, the external service alerts the operator.
  Without it, a dead VM is silent.

## 9. Configuration

In `mesh.yaml`, with defaults, validated in `packages/config` and documented in `docs/configuration.md`:

```yaml
observability:
  enabled: true          # plugins report and the hub stores; false turns both off (hub metrics stay)
  viewers: [pratik]      # humans whose agents may read timelines; empty = nobody via the mesh
  retentionDays: 14
  client:
    maxBufferedEvents: 500
```

In `deploy/.env`, never in git: `ALERT_DISCORD_WEBHOOK_URL` (or the SMTP settings) and `DEADMAN_PING_URL`.
They are added, empty and commented, to the repo's `deploy/.env.example`.

**Scope of the monitoring stack (my call).** In 0.7.0 the Prometheus, Alertmanager and Grafana stack lives
in the repo's deploy files (`deploy/docker-compose.yml` profile `monitoring`, `deploy/monitoring/`). That
is the compose the operator's VM runs from `/opt/agentmesh`. The `setup` wizard and its rendered workspace
compose don't install it yet: other teams get the telemetry, the timeline and `/metrics`, and can copy
`deploy/monitoring/`. Wizard support is a later change.

**Deploying it (my call).**

- Automatic deploys (ADR 0010) keep deploying only the attested hub and bridge images. The monitoring
  images are third-party, pinned by version in the compose file, and never pulled by the forced command.
- The operator starts or upgrades the profile by hand, with a reviewed script,
  `deploy/monitoring/up.sh` (`docker compose --profile monitoring pull` and `up -d`). VM writes are his.
- A release can change alert rules or dashboards in the `/opt/agentmesh` checkout. So, when the profile
  is running, the deploy script sends Prometheus and Alertmanager a reload (`kill -s HUP`). No image
  changes, and no effect on the hub's health gate or rollback.
- `docs/security.md` notes that the forced command gains that reload.

The plugin learns `enabled` (and the hub's limits) from `hello`, so a team that turns it off sends nothing.

## 10. Security and privacy (threat notes for `docs/security.md`)

- **New ingress `telemetry.report`.** Treat it as untrusted data:
  - schema-checked, with no free text;
  - capped per call and per event;
  - rate-limited per actor;
  - attributed by the NATS-proven caller, so a teammate can only forge events about their own agent.
  - Events are never rendered as instructions anywhere, and the timeline marks them as reported by
    the plugin.
- **New read `observe.timeline`.** Viewers only, enforced by the hub. It reveals activity patterns
  (when someone worked), which is why it is operator-only.
- **`/metrics`** is unauthenticated but reachable only from localhost and the compose network. Agent ids
  appear as labels; no content does.
- **The monitoring stack** has no public ports and is reached over SSH. The Grafana admin password is set
  in `.env`, and anonymous access is off.
- **Secrets**: the webhook URL and the dead-man URL are secrets, in `.env`, never logged.
- **Disclosure to teammates** (section 3).
- **Redaction.** No free-text fields exist to redact. Guard reason codes and key names are
  pattern-checked.

## 11. Testing and acceptance

- Unit tests for:
  - every schema;
  - the recorder, buffer, cap and dropped-gap marker;
  - the file collection for guard and hook;
  - guard reason codes, one per check;
  - the timeline formatter;
  - the viewers check;
  - the metrics exposition;
  - retention.
- Integration (real NATS and hub): a plugin's events arrive, a viewer reads them, a non-viewer is
  refused, and an offline buffer is flushed on reconnect.
- **Staging QA (`G:\Projects\AgentMesh-staging`) before release:**
  1. Replay today's guard bug with a deliberately broken guard build. The timeline shows
     `send.unknown_key`, and `RelaysNotForwarded` fires to a test webhook.
  2. Kill a plugin. The timeline shows the disconnect, and `HubDown` stays quiet while `DeliveriesFailing`
     behaves.
  3. Stop the hub. `HubDown` fires to the operator's webhook within 2 minutes, while the dead-man
     check-in keeps going.
  4. Stop the monitoring profile (or the VM). The dead-man check-in stops, and the external service
     alerts.

## 12. Decided, my calls, left to the builder

**Decided by Pratik:**

- Clients report to the hub, continuously.
- The privacy line in section 4.
- What the timeline must show (section 4's lists come from his words).
- Operator-only access, with a config list for future developers.
- Prometheus and Grafana.

**My calls:**

- A separate acked RPC instead of the heartbeat.
- The SQLite store and 14-day retention.
- The tool, the CLI and the text format.
- Alertmanager to a private webhook, and the optional dead man's switch.
- Hand-written metrics with no new dependency.
- The monitoring profile on the hub VM.
- `enabled: true` by default, with disclosure.

**Left to the builder:**

- Exact metric names.
- Buffer and file sizes within the stated caps.
- Batch insert or not.
- Dashboard layout.
- Alert thresholds' starting values.
- Where the timeline formatter lives.
