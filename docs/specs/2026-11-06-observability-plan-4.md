# Observability, phase 1 (release 0.7.0): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every plugin and the hub record schema-checked events about how AgentMesh behaves. The hub stores them,
and the operator, alone, reads a per-agent timeline through a mesh tool and a CLI command.

**Architecture:** a new hub module, `observe`, owns an `events` table (migration 009). It also owns a `ctx.events`
sink that the other modules call. Plugins buffer their events and ship them with a new acked RPC,
`telemetry.report`, on the heartbeat cadence. The guard and the hook append events to a capped file that the plugin
collects. The operator reads them through `observe.timeline`, which only `observability.viewers` may call. That RPC
returns structured events plus text from one pure formatter, so the tool and the CLI print the same thing.

**Tech stack:** Node 24 (`node:sqlite`), TypeScript, zod 4, nats.js v3, vitest, Biome, tsup. No new dependencies.

**Spec:** `docs/specs/2026-11-06-observability-design.md`. Phase 1 only: sections 4–7, the `observability.*` config
in section 9, and the parts of section 10 that cover the RPCs. Section 8 (Prometheus, Grafana, alerts) is phase 2
and out of scope.

## Global Constraints

- **The privacy line, verbatim:** ids, counts, outcomes, error codes, timings and versions only. Never message
  text, prompts, code, file contents, tool output or command lines. No event schema has a free-text field. Every
  "why" is a reason code from a fixed list.
- **Access:** only humans in `observability.viewers` may read timelines. The hub enforces it: a non-viewer gets
  `forbidden`, admins included.
- **Never in the way:** recording is synchronous and cheap. Shipping failures are retried on the next beat and are
  never shown to Claude or the human (debug log only).
- **Spec values:**
  - `observability.enabled: true`, `viewers: []` by default (this team sets `[pratik]`);
  - `retentionDays: 14`;
  - `client.maxBufferedEvents: 500`;
  - at most **100 events** per `telemetry.report`;
  - the guard and hook events file is at most **256 KB**;
  - ship every `heartbeatSeconds` (20 s);
  - a key name in a reason is kept only if it matches `^[A-Za-z_]{1,40}$`.
- **New config (my call, in the spec's spirit):** `observability.maxEventsPerMinute: 300` per agent, enforced by the
  hub. Excess events are counted as dropped, not stored.
- **Files and bundles:**
  - No file over 300 lines (`pnpm check:size`). `apps/hub/src/modules/sessions/sessions.service.ts` is at 280:
    instrument from other files.
  - `plugins/agentmesh/dist/hook.js` and `dist/guard.js` stay built-ins only (no zod). The guard and hook write
    plain JSON lines; the MCP server validates them with zod when it collects them.
  - Every task that changes bundled plugin source rebuilds `plugins/agentmesh/dist` in the same commit.
- **Tests and docs:**
  - Tests never write the real `~/.agentmesh` or `~/.claude`.
  - Docs change in the same task as the behaviour they describe.
  - The version bump happens only in the last task.
- **Compatibility:**
  - A 0.6.x plugin talking to a 0.7.0 hub works unchanged (it just reports nothing).
  - A 0.7.0 plugin whose hub answers `telemetry.report` with an unknown-method error stops reporting for that
    process, and logs it once.

## Review Focus

1. **Lost acks cause duplicates.** A hub restart or a timeout after the hub stored a batch makes the plugin resend
   it. Each event carries a client `id` (uuid), and the hub stores it once (unique index). Test: Task 2,
   "a resent batch is stored once".
2. **A plugin lies about who it is.** An event's `agent` is always the NATS-proven caller, never a field in the
   payload. Test: Task 2, "the caller's id wins over a reported agent field".
3. **Laptop clock skew.** The timeline orders events by hub `received_at`. It shows the plugin's `at` and marks skew
   over 2 minutes. Test: Task 3, "marks a skewed plugin clock".
4. **A runaway loop floods events.** The plugin buffer drops the oldest events and records `dropped`. The hub
   per-agent cap counts the excess. Tests: Task 5, "keeps the newest 500 and records the gap"; Task 2, "caps
   events per agent per minute".
5. **Observability turned off.** With `enabled: false` the hub's `hello` says so, the plugin records nothing, and
   `telemetry.report` is refused. Tests: Task 2 and Task 5.

---

### Task 1: Event types, RPC contracts and config

**Files:**

- Create: `packages/protocol/src/observe.ts` and `packages/protocol/src/observe.test.ts`.
- Create: `packages/protocol/src/rpc/observe.ts`.
- Modify: `packages/protocol/src/rpc/index.ts` (spread `observeMethods`), `packages/protocol/src/index.ts`
  (export `observe`), `packages/protocol/src/rpc/session.ts` (hello result).
- Modify: `packages/config/src/schema/policy.ts` (`ObservabilityConfig`), `packages/config/src/schema/mesh.ts`,
  `packages/config/src/validate.ts`, and a test next to it.
- Modify: `config/examples/mesh.yaml` (commented section, `viewers: []`) and `docs/configuration.md`.

**Interfaces (produces):**

- `REASON_CODES`: a readonly tuple of reason codes, used by the guard (Task 7) and the activation (Task 6).
  - Guard: `send.unknown_key`, `send.bad_address`, `send.alias_mismatch`, `send.content_mismatch`,
    `send.no_record`, `send.claim_failed`, `list_agents`, `path.outside_worktree`, `command.not_listed`,
    `marker.unverified`, `guard.error`.
  - Activation: `activation.wrong_code`, `activation.guard_down`, `activation.not_window`,
    `activation.another_window_live`, `activation.no_proof`, `activation.hub_error`.
  - The implementer adds any further case that `guard/decide.ts` or `tools/sessions.ts` can refuse with, keeping
    the `area.snake_case` form.
- `ReportedEvent`: a zod discriminated union on `kind`. Every member has:
  - `id`: uuid;
  - `at`: ISO time;
  - `session`: `SessionId | null`;
  - `source`: `'plugin' | 'guard' | 'hook'`;
  - the kind's fields from spec §4 (`connected`, `nats`, `activation`, `tool`, `delivery`, `relay`, `guard`, `hook`,
    `dropped`).

  Ids use the existing id schemas (`thr-N`, `task-N`, message ids). Strings are enums or patterned; nothing is
  free text.
- `HubEvent`: the same shape for hub kinds (`session`, `delivery`, `relay`, `orphan`, `rpc`, `auth`), with
  `source: 'hub'`.
- `ObservedEvent = (ReportedEvent | HubEvent) & { agent: string; receivedAt: string }`.
- RPC `telemetry.report`:
  - callers: `['agent']`;
  - params: `{ events: ReportedEvent[] }`, with at most 100 events;
  - result: `{ accepted: number; dropped: number }`.
- RPC `observe.timeline`:
  - callers: `['agent']`;
  - params: `{ agent?: string; session?: SessionId; thread?: ThreadId; since?: string (default 2h); until?: string;
    kinds?: string[]; limit?: number (default 500, max 2000) }`, where `since` and `until` are ISO times or a
    relative duration (`30m`, `2h`, `1d`);
  - result: `{ events: ObservedEvent[]; text: string; truncated: boolean }`.
- `session.hello` result gains `observability: { enabled: boolean; maxBufferedEvents: number }`, defaulting to
  `{ enabled: false, maxBufferedEvents: 500 }`, so a 0.7.0 plugin on an older hub records nothing.
- Config `observability`:
  - `enabled` (default `true`);
  - `viewers` (human ids, default `[]`);
  - `retentionDays` (default `14`, min 1);
  - `maxEventsPerMinute` (default `300`);
  - `client.maxBufferedEvents` (default `500`, min 50).

  Validation fails when a viewer isn't a configured human, with the message
  `observability.viewers: "<id>" is not a human in this mesh`.

- [ ] **Step 1: Write the failing tests.**
  - `observe.test.ts`:
    - one valid sample per kind parses;
    - a `tool` event with an extra `text` field is rejected (strict objects);
    - a `guard` event whose `key` is `"sum mary"` is rejected;
    - `telemetry.report` refuses 101 events;
    - an old hello result without `observability` parses to `{ enabled: false, maxBufferedEvents: 500 }`.
  - The config test:
    - defaults apply when the section is omitted;
    - `viewers: [ghost]` fails with the exact message above.
- [ ] **Step 2:** run `pnpm vitest run packages/protocol packages/config`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Use `.strict()` on every event object. `REASON_CODES` and the kind enums are exported
  `as const` tuples, so the guard (built-ins only) can import plain arrays from `observe.ts` without pulling in zod.
  If `observe.ts` imports zod at module level, put the plain constants in `packages/protocol/src/observe-codes.ts`
  (no zod) and re-export them.
- [ ] **Step 4:** run the same tests, then `pnpm check`. Expected: PASS.
- [ ] **Step 5:** commit `"Protocol: observability events, telemetry.report and observe.timeline; config"`.

### Task 2: The hub's event store and `telemetry.report`

**Files:**

- Create: `apps/hub/src/db/migrations/009-events.ts`. Modify `apps/hub/src/db/migrate.ts`.
- Create: `apps/hub/src/modules/observe/events.repo.ts`, `observe.service.ts`, `index.ts` and
  `observe.service.test.ts`.
- Modify: `apps/hub/src/contracts.ts` (`EventSink`), `apps/hub/src/context.ts` (`events: EventSink`),
  `apps/hub/src/runtime/modules.ts` (register the module), and `apps/hub/src/testing/harness.ts`.
- Modify: `apps/hub/src/rpc/rate-limit.ts`, adding `telemetry.report` and `observe.timeline` to the free list. The
  per-agent cap below replaces the shared bucket, so telemetry never competes with real work.

**Interfaces:**

- **Consumes:** Task 1's `ReportedEvent`, `HubEvent` and config.
- **Produces:**
  - `interface EventSink { record(agent: string, event: HubEvent): void }` on `HubContext` as `ctx.events`. It is a
    no-op when `observability.enabled` is false, never throws, and logs failures at debug.
  - `ObserveService.report(agent: string, events: ReportedEvent[]): { accepted: number; dropped: number }`.
  - `ObserveService.query(filter): ObservedEvent[]`, used by Task 3.
  - A tick job that prunes events older than `retentionDays`.
- **Migration 009:** `events(id TEXT PRIMARY KEY, agent TEXT NOT NULL, session TEXT, thread TEXT, kind TEXT NOT NULL,
  source TEXT NOT NULL, at TEXT NOT NULL, received_at TEXT NOT NULL, body TEXT NOT NULL)`, indexed on
  `(agent, received_at)`, `(session, received_at)` and `(thread, received_at)`. `body` is the validated event as
  JSON. Hub events get a uuid id.

- [ ] **Step 1: Write the failing tests** (`observe.service.test.ts`):
  - "stores reported events under the caller, and the caller's id wins over a reported agent field";
  - "a resent batch is stored once";
  - "caps events per agent per minute": with `maxEventsPerMinute: 5`, 8 events give `accepted: 5, dropped: 3`;
  - "refuses telemetry when observability is off" (`forbidden`, message
    `observability is turned off on this hub`);
  - "ctx.events records a hub event, and records nothing when off";
  - "prunes events older than retentionDays";
  - a router-level test that `telemetry.report` from a human or service caller is refused.
- [ ] **Step 2:** run `pnpm vitest run apps/hub/src/modules/observe`. Expected: FAIL.
- [ ] **Step 3: Implement** the repo (insert-or-ignore on `id`), the service (cap with a per-agent sliding minute)
  and the handler (`telemetry.report` → `report(call.actor.id, params.events)`). The harness wires a real sink on the
  test db.
- [ ] **Step 4:** run the focused tests, then `pnpm check`. Expected: PASS.
- [ ] **Step 5:** commit `"Hub: an event store with retention; telemetry.report"`.

### Task 3: `observe.timeline` and the formatter

**Files:**

- Create: `apps/hub/src/modules/observe/timeline.ts` (a pure formatter) and `timeline.test.ts`.
- Modify: `apps/hub/src/modules/observe/index.ts` (handler) and `observe.service.ts` (viewers check, query).

**Interfaces:**

- **Consumes:** Task 2's `query`.
- **Produces:** `formatTimeline(events: ObservedEvent[], opts: { title: string; now: Date }): string`.
- **The format** follows spec §7:
  - A header: `<agent> · plugin <v> · Claude Code <v> · <os> · <window>`. The versions come from the latest
    `connected` event; `unknown` when there is none.
  - Then one line per event: `HH:MM:SS  <kind padded to 13>  <details>`.
  - A delivery's hub `sent`, plugin `received` and `pushed`/`push_failed` events for one message id fold into one
    line: `hub sent → plugin got it → pushed to Claude ✓ 0.4s`. If a stage is missing, it ends `✗ (<last stage>)`.
  - Local time comes from `opts.now`'s zone.
  - The tests compute expected times with the same zone, so they are zone-independent.

- [ ] **Step 1: Write the failing tests** (`timeline.test.ts`):
  - "folds a delivery's journey into one line";
  - "a delivery that was received but never pushed ends ✗ (received)";
  - "shows a guard denial with its reason and key" (`guard denied: send.unknown_key (summary) ✗`);
  - "marks a skewed plugin clock" (the plugin `at` is 5 minutes before `receivedAt`, so the line ends
    `(clock +5m)`);
  - "the header uses the latest connected event's versions";
  - and, through the handler: "a non-viewer is refused with forbidden" (message
    `the timeline is for this mesh's operators only`), "a viewer's agent reads any agent's timeline", and
    "`truncated` is true past the limit".
- [ ] **Step 2:** run `pnpm vitest run apps/hub/src/modules/observe`. Expected: FAIL.
- [ ] **Step 3:** implement. The viewers check is that the caller agent's owner is in `observability.viewers`.
  Order events by `receivedAt`, then `at`.
- [ ] **Step 4:** run the focused tests, then `pnpm check`. Expected: PASS.
- [ ] **Step 5:** commit `"Hub: observe.timeline for the operator, with one text format"`.

### Task 4: The hub records its own events

**Files** (modify, plus tests next to each; keep `sessions.service.ts` ≤ 285):

- `apps/hub/src/modules/sessions/open.ts`: `session.opened`, and `session.hello` with versions.
- `liveness.ts`: `away`, `closed` and `evicted` (from `expireSessions`, `releaseAndClose` callers and
  `evictStalest`).
- `takeover.ts`: `taken_over`, with the replaced sessions and threads.
- `dispatcher.ts`: delivery `sent`, `acked` and `failed` (with code), and relay `sent` and `answered`.
- `orphans.ts`: `recorded`, `escalated` and `settled`.
- `apps/hub/src/rpc/router.ts`: `rpc` errors, with method, caller and code. `telemetry.report` itself is skipped.
- `apps/hub/src/modules/callout`: `auth` denied, with a reason code.

**Interfaces:**

- **Consumes:** `ctx.events.record(agent, HubEvent)`.
- **Produces:** nothing new.

- [ ] **Step 1: Write the failing tests**, one per site:
  - "a session that goes away and closes records away then closed";
  - "a delivery records sent and acked with the message and thread";
  - "a takeover records taken_over with the threads";
  - "an orphan escalation records escalated";
  - "an RPC error records the method and code but no params";
  - "a callout denial records auth denied".

  Use the hub harness and query the `events` table.
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3:** add one `ctx.events.record(...)` per site, with no payload text, then rebuild nothing (hub only).
- [ ] **Step 4:** run `pnpm check`. Expected: PASS.
- [ ] **Step 5:** commit `"Hub: record sessions, deliveries, relays, orphans, RPC errors and auth denials"`.

### Task 5: The plugin's recorder and shipper

**Files:**

- Create: `plugins/agentmesh/src/telemetry/recorder.ts`, `shipper.ts` and `events-file.ts` (built-ins only), plus
  tests.
- Modify: `plugins/agentmesh/src/session.ts` (wiring; keep ≤ 270 lines; put the logic in `telemetry/`),
  `plugins/agentmesh/src/main.ts`, `plugins/agentmesh/src/server.ts` (the MCP `getClientVersion()` getter),
  `packages/bus/src/connect.ts` (an optional `onStatus(type: 'disconnect' | 'reconnect' | 'error')` callback for
  `watchStatus`).

**Interfaces:**

- **Consumes:** Task 1's types, and `hello.observability`.
- **Produces:**
  - `class Recorder`:
    - `constructor(opts: { max: () => number; enabled: () => boolean; now?: () => Date })`;
    - `record(e: Omit<ReportedEvent, 'id' | 'at'> & Partial<Pick<ReportedEvent, 'id' | 'at'>>): void`;
    - `take(n: number): ReportedEvent[]`;
    - `putBack(events: ReportedEvent[]): void`.

    When the buffer is full it drops the oldest events and keeps one pending `dropped` event with the running
    count.
  - `appendEvent(dataDir: string, event: object): void` (in `events-file.ts`, built-ins only): appends one JSON line
    to `events-<pid>.jsonl`, skipping it if the file is at 256 KB.
  - `collectEventFiles(dataDir: string): unknown[]`: reads and deletes them.
  - `startShipper(deps: { hub; recorder; dataDir; intervalMs; logger }): () => void`. Every interval it collects the
    event files into the recorder (validating each line with zod and dropping invalid ones), then sends up to 100
    events with `telemetry.report`. On success the events leave the buffer; on failure they are put back. An
    unknown-method error stops the shipper and logs once. An error-kind event triggers a send at most every 2 s.
  - `session.ts` records a `connected` event after each hello: plugin version, Claude Code version
    (`server.getClientVersion()?.version ?? 'unknown'`), `process.platform`, `process.arch`,
    `process.versions.node`, `meshWindow` and `pull`. It also records `nats` events from `onStatus`.

- [ ] **Step 1: Write the failing tests.**
  - `recorder.test.ts`:
    - "keeps the newest 500 and records the gap" (600 records → 500 kept plus `dropped` with count 100);
    - "records nothing when disabled".
  - `shipper.test.ts`, with the fake hub:
    - "ships in batches of 100 and drops only what the hub acknowledged";
    - "puts a batch back when the call fails";
    - "stops after an unknown-method error";
    - "collects and validates the guard's file, dropping a bad line".
  - `events-file.test.ts`: "stops appending at 256 KB".
  - `session.test.ts`: "a hello records connected with the Claude Code version". Use temp `CLAUDE_PLUGIN_DATA`.
- [ ] **Step 2:** run `pnpm vitest run plugins/agentmesh/src/telemetry plugins/agentmesh/src/session.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** implement and wire it. Rebuild `plugins/agentmesh/dist`.
- [ ] **Step 4:** run `pnpm check`. Expected: PASS; `hook.js` and `guard.js` have no zod.
- [ ] **Step 5:** commit `"Plugin: record events and ship them to the hub on the heartbeat"`.

### Task 6: The plugin records tools, activations, deliveries and relays

**Files** (modify, with tests next to each):

- `plugins/agentmesh/src/tools/registry.ts` (`run`): a `tool` event with name, `ok` or code, ms, and the ids among
  `thread_id`, `task_id`, `plan_id`. Never other args.
- `tools/activation.ts` and `tools/sessions.ts`: `activation` phases with reason codes.
- `inbox/session-inbox.ts`: delivery `received`, `pushed`, `push_failed`, `deduped` and `held`.
- `inbox/window-relay.ts`: relay `pushed`.
- `relay/forward-record.ts` or the shipper: relay `expired`. Each interval, an unclaimed forward record past its
  expiry is reported once and then removed.
- `ToolDeps` (`tools/types.ts`) and `fake-hub.ts` gain `recorder`.

**Interfaces:**

- **Consumes:** Task 5's `Recorder.record`.
- **Produces:** nothing new.

- [ ] **Step 1: Write the failing tests.**
  - "a failing tool records its error code and the thread id, but none of its text arguments" (call `reply` with a
    `text`; the event has no `text`);
  - "a refused window activation records activation refused with activation.guard_down";
  - "a renewal records renewed";
  - "a pushed delivery records received then pushed";
  - "a push that throws records push_failed";
  - "a relay push records relay pushed";
  - "an expired unclaimed pointer records relay expired once".
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3:** implement. Rebuild `plugins/agentmesh/dist`.
- [ ] **Step 4:** run `pnpm check`. Expected: PASS.
- [ ] **Step 5:** commit `"Plugin: record tool calls, activations, deliveries and relay outcomes"`.

### Task 7: Guard reason codes, and guard and hook events

**Files** (modify, with tests next to each):

- `plugins/agentmesh/src/guard/decide.ts` (`GuardDecision` gains `code`), `guard/send.ts` (one code per failed
  check, plus `key` for `send.unknown_key`), `guard/commands.ts` and `guard/paths.ts` as needed.
- `plugins/agentmesh/src/guard.ts`: append a `guard` event for every deny and ask, and a relay `claimed` event when
  `SendMessage` passes, through `appendEvent`.
- `plugins/agentmesh/src/hook.ts` and `hook/prompt.ts`: append `hook` events (`note_shown` with the count,
  `pointer_labelled`, `window_labelled`, `not_mesh_labelled`, `error`).

**Interfaces:**

- **Consumes:** `REASON_CODES` (the plain constants) and `appendEvent`.
- **Produces:** guard decisions carrying `code`.

- [ ] **Step 1: Write the failing tests.**
  - `send.test.ts`: each failed check returns its code:
    - `notify_when_idle` → `send.unknown_key` with key `notify_when_idle`;
    - wrong address → `send.bad_address`;
    - a content preview that isn't a prefix → `send.content_mismatch`;
    - no record → `send.no_record`.

    A key like `"x y"` gives `send.unknown_key` with no key.
  - `guard.entry.test.ts`: a denied `SendMessage` appends one `guard` line with the code. A passing one appends a
    relay `claimed` line. Use a temp data dir.
  - `hook.entry.test.ts`: the reply note appends `note_shown` with the count.
  - `bundles.smoke.test.ts`: the built `guard.js` writes the guard line, and `hook.js` and `guard.js` still have no
    zod.
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3:** implement. Appending never throws: wrap it and continue, because the guard's decision must not
  change. Rebuild `plugins/agentmesh/dist`.
- [ ] **Step 4:** run `pnpm check`. Expected: PASS.
- [ ] **Step 5:** commit `"Guard and hook: reason codes, and events for the timeline"`.

### Task 8: The `timeline` tool and `agentmesh timeline`

**Files:**

- Create: `plugins/agentmesh/src/tools/observe.ts` (the `timeline` tool) and a test. Register it in
  `tools/registry.ts`.
- Create: `apps/cli/src/commands/timeline.ts` and a test. Register it in `apps/cli/src/main.ts`.

**Interfaces:**

- **Consumes:** RPC `observe.timeline`.
- **The tool `timeline`:**
  - description: `Operator only: this mesh's event timeline for an agent, session or thread (no message contents).
    Others are refused.`;
  - input: `{ agent?, session?, thread_id?, since?, until?, limit? }`;
  - `mutating: false`;
  - it returns the RPC's `text`, plus `\n(truncated: narrow the window or raise limit)` when `truncated`.
- **The CLI:** `agentmesh timeline [--agent <id>] [--session <id>] [--thread thr-N] [--since 2h] [--until <t>]
  [--limit N] [--json]`.
  - It reads `~/.agentmesh/agent.json` (agent id, NATS URL, seed, prefix).
  - It connects once (`connectOnce`), calls through `RpcClient` and prints `text`, or the events as JSON lines with
    `--json`.
  - Its help says it is for the mesh's operators. A refusal prints the hub's message and exits 1.

- [ ] **Step 1: Write the failing tests.**
  - The tool test, with the fake hub: "prints the hub's text, and a forbidden refusal as an error".
  - The CLI test, with a fake RPC client: "prints text, --json prints one event per line, and exits 1 on
    forbidden".
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3:** implement. Rebuild `plugins/agentmesh/dist` (`cli.js` and `server.js`).
- [ ] **Step 4:** run `pnpm check`. Expected: PASS. The `instructions.test.ts` length budget still holds: the new
  tool adds nothing to the instructions.
- [ ] **Step 5:** commit `"Timeline: a mesh tool and agentmesh timeline for the operator"`.

### Task 9: End to end

**Files:**

- Create: `tests/integration/observe.e2e.test.ts`, following the `mesh-window.e2e.test.ts` pattern.

- [ ] **Step 1: Write the test** (real NATS, the hub and the bundled plugin):
  - "a plugin's events reach the hub and a viewer reads them". The plugin connects and calls `peers` and a failing
    tool; after one ship interval (set `heartbeatSeconds: 1` in the test config), the viewer's `observe.timeline`
    shows `connected`, the `tool` lines and the hub's `session opened`.
  - "a non-viewer is refused".
  - "an offline plugin ships its buffer when it reconnects". Stop and restart NATS, or close and reopen the plugin's
    connection, whichever the harness supports. If neither is practical, cover it at unit level in Task 5 and say so
    in the report.
- [ ] **Step 2:** run the integration suite with the cached nats-server (`AGENTMESH_TEST_NATS_BIN`,
  `AGENTMESH_TEST_NATS`). Expected: PASS, and the new file is not skipped.
- [ ] **Step 3:** commit `"Tests: observability end to end"`.

### Task 10: Docs and the threat notes

**Files:**

- Modify: `docs/security.md`, which needs:
  - a section "Observability" with spec §10's notes for phase 1: the `telemetry.report` ingress, the `observe.timeline`
    viewers-only read, attribution by caller, caps, no free text, the privacy line, and disclosure;
  - a paragraph "What AgentMesh records about your sessions, and what it never records".
- Modify: `docs/protocol.md` (both RPCs and the hello field), `docs/configuration.md` (done in Task 1; check it),
  `plugins/agentmesh/README.md` (the disclosure paragraph and the `timeline` tool), `README.md` (one line),
  `CLAUDE.md` (status, the new module, the built-ins file `telemetry/events-file.ts`, and the `timeline` tool in the
  tool count).
- Create: `docs/adr/0011-observability.md`: the decisions and my calls from spec §12, phase 1 versus phase 2, and why
  there's a separate acked RPC.

- [ ] **Step 1:** write the docs in the project's voice.
- [ ] **Step 2:** run `pnpm check`. Expected: PASS.
- [ ] **Step 3:** commit `"Docs: observability phase 1, its privacy line and threat notes"`.

### Task 11: Release 0.7.0

**Files:** `packages/common/src/version.ts` (`VERSION = '0.7.0'`), the 9 workspace `package.json` files,
`plugins/agentmesh/.claude-plugin/plugin.json`, and `plugins/agentmesh/dist/*` (rebuilt).

- [ ] **Step 1:** bump every version file (`version.test.ts` pins them), then run `pnpm --filter @agentmesh/plugin
  build`.
- [ ] **Step 2:** run `pnpm check` and the integration suite. Expected: PASS, with none skipped.
- [ ] **Step 3:** commit `"Release 0.7.0: observability phase 1, the event timeline"`.
- [ ] **Step 4: Staging QA, with the operator.** Bring up `G:\Projects\AgentMesh-staging` with this branch, and set
  `observability.viewers: [pratik]` in the staging config. Then:
  1. In the window, `timeline` shows activation, tool calls and deliveries.
  2. `tester-agent` calling `timeline` is refused.
  3. Run the window with a guard built from a commit before 4f8f79f (the `summary` bug). Its denials show
     `send.unknown_key (summary)`.
  4. A NATS outage shows `disconnect` and `reconnect`, and the buffered events arrive afterwards.
  5. `agentmesh timeline --agent tester-agent --since 30m` from the staging home prints the same timeline.
