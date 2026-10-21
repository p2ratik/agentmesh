# Session routing — implementation plan 1 of 3 (sessions and delivery)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:**

- Each Claude Code session is its own hub-tracked session.
- Messages go only to the active session that owns the work, so they are never swallowed by a
  session that cannot show them.

**Architecture:**

- The hub's SQLite outbox becomes the agent's only queue. On each flush, a pure routing function
  picks the session:
  1. the owner of the thread, its parent thread or its task;
  2. otherwise the asker's pick;
  3. otherwise a session in the repo;
  4. otherwise the longest-active session.
- The hub hands the batch to that session over core NATS, as a request on
  `{p}.session.{agent}.{session}` with the reply on `{p}.ack.{agent}.{token}`. The plugin acks only
  the messages it pushed into Claude Code.
- The per-agent JetStream inbox is retired.
- Ownership is recorded when a session's RPC succeeds (pure `claimTargets`).
- Sessions go away when heartbeats stop, and close after a grace period.

**Tech stack:** Node 24 (`node:sqlite`), TypeScript 7, zod 4, nats.js v3 (`@nats-io/*`), vitest 5,
MCP SDK 1.32.1, tsup, pnpm 10.

**Spec:** `docs/specs/2026-10-21-session-routing-design.md`. Read §3 (Part A), §8 and §9 before
starting. Plans 2 and 3 follow once this plan has merged into `agents`, because they build on the
interfaces created here:

- Plan 2 covers Part B: `action`/`status` classes, no echoes, piggybacked status and the split
  inbox.
- Plan 3 covers Parts C and D: the briefing card, hooks, transcript handover, `task_get` and
  `thread` fixes, and the skill. It also covers the one Part A behaviour that needs the Claude
  conversation id from hooks: a `claude --resume` of an active conversation re-activating by itself.

## Global constraints

- Work in `G:\Projects\AgentMesh-session-routing`, on branch `agent/pratik/session-routing`, which
  is based on `origin/agents`. Never edit other agents' branches. Rebase onto PR #19 if it merges
  first.
- No source file over 300 lines; `pnpm check:size` enforces it. Keep routing and claims logic pure
  (no I/O).
- Every wire shape is a zod schema in `packages/protocol`, and every new config option lives in
  `packages/config`. Each option gets a default, validation, a commented example in
  `config/examples/mesh.yaml` and an entry in `docs/configuration.md`.
- `@modelcontextprotocol/sdk` stays pinned at `1.32.1`. tsup keeps `removeNodeProtocol: false` and
  the `createRequire` banner.
- The plugin version becomes `0.2.0` in `plugins/agentmesh/.claude-plugin/plugin.json`,
  `plugins/agentmesh/package.json` and `plugins/agentmesh/src/server.ts` (`VERSION`). Rebuild and
  commit `plugins/agentmesh/dist/server.js`.
- The hub refuses `session.hello` from plugins older than `0.2.0`, with an update instruction. There
  is no compatibility mode (spec §10, my call).
- Secrets never go into logs or tool output. Session descriptions go through `redactSecrets`.
- Windows dev box:
  - Write files with the Write/Edit tools, never bash heredocs.
  - `python3` is a stub; use node.
  - Never kill processes you did not start: another agent runs a nats-server on this laptop.
- Run `pnpm check` before every commit that touches TypeScript. It must stay green; the baseline
  was 237 passed, 20 skipped.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push
  or open a PR until Pratik says so.

## Review focus

1. **A connected session that never activated** must never receive a push or take a delivery,
   including when it is the agent's only session. Task 6 pins this.
2. **Laptop sleep:**
   - Heartbeats stop for longer than `presence.offlineAfterSeconds` (75 s) but less than
     `presence.ownershipGraceMinutes` (120). The session must come back live with everything it
     owned, and deliveries must resume.
   - After the grace period, its work moves on, and on reconnect it takes back only the threads
     nobody else took.
   - Task 5 pins both.
3. **Hub restart mid-conversation.** Sessions and ownership live in SQLite, so a new hub process
   over the same database must route a reply to the same session. Task 6 pins this.
4. **A batch that is only partly acked,** for example when the plugin pushed two of three threads
   before a failure. Acked messages are published exactly once; the rest stay pending and are not
   pushed twice. Tasks 6 and 9 pin this.
5. **A pre-0.2.0 plugin connecting after the upgrade** gets a clear "update the plugin" error, not
   silence. Task 4 pins this.
6. **A session that died without saying bye** (killed terminal, crash) makes the hub wait out the
   5 s request timeout. That wait must never delay other agents or sessions; Task 6 pins it with
   concurrent sends. The session also goes away on the first timeout, so later flushes skip it.

---

### Task 1: Protocol contracts for sessions

**Files:**

- Create: `packages/protocol/src/sessions.ts` and `packages/protocol/src/sessions.test.ts`.
- Modify:
  - `packages/protocol/src/subjects.ts`
  - `packages/protocol/src/primitives.ts` (`PeerInfo`)
  - `packages/protocol/src/messages.ts` (`MessageRefs`)
  - `packages/protocol/src/rpc/envelope.ts`
  - `packages/protocol/src/rpc/session.ts`
  - `packages/protocol/src/rpc/messaging.ts` (`message.send`)
  - `packages/protocol/src/index.ts` (export `sessions.ts`)

**Interfaces (produces):**

- `subjects(p)`:
  - `.session(agentId, sessionId)` → `${p}.session.${agentId}.${sessionId}`
  - `.sessionAll(agentId)` → `${p}.session.${agentId}.*`
  - `.ack(agentId, token)` → `${p}.ack.${agentId}.${token}`
  - `.ackAll(agentId)` → `${p}.ack.${agentId}.>`
- `SESSION_ID_PATTERN = /^s-[a-z0-9]{12}$/`, plus `SessionId = z.string().regex(SESSION_ID_PATTERN)`.
- `SessionView = z.object({ id, active: z.boolean(), description: z.string().nullable(), repo:
  z.string().nullable(), branch: z.string().nullable(), owns: z.array(z.string()) })`. `owns` holds
  thread keys (`thr-3`).
- `SessionSummary = z.object({ id, description: z.string(), repo, branch, activeSince: IsoDate,
  tasks: z.array(z.string()) })`. `PeerInfo` gains `sessions: z.array(SessionSummary).default([])`.
- `SessionInbound = z.discriminatedUnion('type', [...])` with two variants:
  - `{ type: 'deliver', messages: z.array(MeshMessage).min(1).max(100) }`
  - `{ type: 'expired' }`
- `SessionAck = z.object({ delivered: z.array(z.string()) })`.
- `MessageRefs` gains `repo: z.string().max(200).optional()` and `session:
  z.string().optional()`. `session` is the sender's pick of the recipient session.
- `RpcRequestEnvelope` gains `session: z.string().max(64).optional()`.
- `RpcResponseEnvelope`'s ok branch becomes `{ ok: true; result: T; notes?: string[] }`.
- `session.hello`:
  - params add `previousSessionId: z.string().optional()`;
  - the result adds `sessionId: SessionId` and `reclaimed: z.array(z.string())`.
- New methods, all with `callers: ['agent']`:
  - `'session.activate'`: params `{ description: z.string().min(1).max(200) }`, result
    `SessionView`.
  - `'session.deactivate'`: params `{}`, result `SessionView`.
  - `'session.describe'`: params `{ description: z.string().min(1).max(200) }`, result
    `SessionView`.
  - `'session.take'`: params `{ threadId?: string; taskId?: string }`, refined to exactly one;
    result `{ threadId: z.string(), previousSession: z.string().nullable() }`.
- `message.send` params add `toSession: z.string().optional()` and `repo:
  z.string().max(200).optional()`.

- [ ] **Step 1: Write the failing tests** in `packages/protocol/src/sessions.test.ts`:

```ts
it('builds session and ack subjects under the prefix', () => {
  const s = subjects('mesh');
  expect(s.session('alice-agent', 's-abc123def456')).toBe('mesh.session.alice-agent.s-abc123def456');
  expect(s.sessionAll('alice-agent')).toBe('mesh.session.alice-agent.*');
  expect(s.ackAll('alice-agent')).toBe('mesh.ack.alice-agent.>');
});
it('accepts hub-issued session ids only', () => {
  expect(SessionId.safeParse('s-abc123def456').success).toBe(true);
  expect(SessionId.safeParse('s-ABC.def').success).toBe(false);
});
it('parses a deliver batch and an expiry notice', () => {
  expect(SessionInbound.parse({ type: 'expired' })).toEqual({ type: 'expired' });
  expect(SessionInbound.safeParse({ type: 'deliver', messages: [] }).success).toBe(false);
});
it('session.take needs exactly one of threadId and taskId', () => {
  const p = RPC_METHODS['session.take'].params;
  expect(p.safeParse({ threadId: 'thr-1' }).success).toBe(true);
  expect(p.safeParse({}).success).toBe(false);
  expect(p.safeParse({ threadId: 'thr-1', taskId: 'task-1' }).success).toBe(false);
});
it('peers default to no sessions', () => {
  expect(PeerInfo.parse({ ...minimalPeer }).sessions).toEqual([]);
});
```

Build `minimalPeer` in the test from the existing `PeerInfo` fields.

- [ ] **Step 2:** Run `pnpm vitest run packages/protocol/src/sessions.test.ts`. Expected: it fails
  because `sessions` is not exported.
- [ ] **Step 3:** Implement the interfaces above.
- [ ] **Step 4:** Run the test and `pnpm typecheck`.
  - Expected: the test passes.
  - Typecheck errors in `apps/hub`/`plugins` about the hello result (missing `sessionId`) are
    expected; Task 4 fixes them. Note them and carry on.
- [ ] **Step 5:** Commit `Protocol: session subjects, envelope session/notes, session RPCs`.

### Task 2: Bus — permissions, session in the envelope, notes in responses

**Files:**

- Modify:
  - `packages/bus/src/permissions.ts`
  - `packages/bus/src/permissions.test.ts`
  - `packages/bus/src/rpc-server.ts`
  - `packages/bus/src/rpc-client.ts`
- Test: `packages/bus/src/rpc-envelope.test.ts`. Create it if no RPC unit test exists. Use a fake
  `Msg` and a dispatcher; no NATS needed.

**Interfaces:**

- Consumes: Task 1's subjects, envelope and `notes`.
- Produces:
  - `RpcCallContext` gains `session?: string` and `notes?: string[]`. `serveRpc` always sets
    `notes: []`; in-process callers (tests, `createHub` without NATS) may omit it. The dispatcher
    may push into `notes`, and `serveRpc` includes them in the ok response when it is non-empty.
  - `CallOptions` gains `session?: string`.
  - `RpcClient.callWithNotes<M>(method, params, options): Promise<{ result: RpcResult<M>; notes:
    string[] }>`. `call` returns `(await callWithNotes(...)).result`.
  - `permissionsFor` for `agent` changes:
    - publish adds `subs.ackAll(id)`;
    - subscribe adds `subs.sessionAll(id)`;
    - the delivery `pullConsumerApi` entries are removed, because agents no longer pull JetStream.

- [ ] **Step 1: Write the failing tests.**
  - In `permissions.test.ts`, the agent `alice-agent` with prefix `mesh`:
    - may publish `mesh.ack.alice-agent.>`;
    - may subscribe `mesh.session.alice-agent.*`;
    - has no `$JS.API.CONSUMER.MSG.NEXT.MESH_DELIVERY.inbox-alice-agent`.
  - In `rpc-envelope.test.ts`:
    - `'passes the envelope session to the dispatcher'`: the `ctx.session` it sees equals
      `'s-abc123def456'`.
    - `'returns notes the dispatcher added'`: the response JSON has
      `{ ok: true, result: 1, notes: ['n1'] }`.
    - `'omits empty notes'`: the response has no `notes` key.
- [ ] **Step 2:** Run `pnpm vitest run packages/bus`. Expected: the new tests fail.
- [ ] **Step 3:** Implement the changes.
  - `serveRpc` creates `notes: []` per call.
  - The CLI's `nats-config` and the callout both use `permissionsFor`, so they pick up the change.
- [ ] **Step 4:** Run `pnpm vitest run packages/bus apps/cli`. Expected: pass. If a CLI snapshot of
  a rendered `nats.conf` changed, update it and check that the diff is exactly the permission
  change.
- [ ] **Step 5:** Commit `Bus: agents subscribe to their sessions and ack deliveries; RPC notes`.

### Task 3: Hub — session tables, pure routing and claims

**Files:**

- Create:
  - `apps/hub/src/db/migrations/004-sessions.ts`
  - `apps/hub/src/modules/sessions/sessions.repo.ts`
  - `apps/hub/src/modules/sessions/routing.ts` and `routing.test.ts`
  - `apps/hub/src/modules/sessions/claims.ts` and `claims.test.ts`
- Modify: `apps/hub/src/db/migrate.ts` (register version 4).

**Schema (migration 004):**

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  liveness TEXT NOT NULL CHECK (liveness IN ('live', 'away', 'closed')),
  description TEXT,
  repo TEXT,
  branch TEXT,
  client_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  last_seen TEXT NOT NULL,
  away_since TEXT,
  closed_at TEXT,
  released TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX sessions_by_agent ON sessions(agent_id, liveness);
CREATE TABLE thread_owners (
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  since TEXT NOT NULL,
  PRIMARY KEY (thread_id, agent_id)
);
CREATE INDEX thread_owners_by_session ON thread_owners(session_id);
```

`released` holds the JSON array of thread ids released at close, for reclaim.

**Interfaces (produces):**

- `routing.ts`:

```ts
export interface RouteSession { id: string; active: boolean; liveness: 'live' | 'away'; repo: string | null; activatedAt: string | null }
export interface RouteInput {
  sessions: RouteSession[];        // the agent's non-closed sessions
  threadOwner: string | null;      // session owning the message's thread (this agent)
  parentOwner: string | null;      // owner of the thread's parent
  taskOwner: string | null;        // owner of refs.taskId's thread, when it differs
  picked: string | null;           // refs.session
  repo: string | null;             // refs.repo, else the task's repo
}
export type Route =
  | { kind: 'deliver'; sessionId: string; claim: boolean; reason: string }
  | { kind: 'wait'; reason: string };
export function routeDelivery(input: RouteInput): Route;
```

- Rule order (spec §3):
  1. **Owner.** `threadOwner`, then `parentOwner`, then `taskOwner`. Use the first one that is in
     `sessions`.
     - An active, live owner gets delivery. `claim` is false for the thread owner and true for the
       parent or task owner. The reasons are `owns thread`, `owns parent thread` and `owns task`.
     - An inactive or away owner means `wait`, with reason `held for <id> (inactive|away)`.
     - An owner id that is not in `sessions` (closed) is ignored.
  2. **Pick.** If `picked` is an active, live session: deliver with claim, reason
     `picked by sender`.
  3. **Repo.** Active, live sessions with `repo === input.repo`, earliest `activatedAt`. Deliver
     with claim, reason `in repo <repo>`.
  4. **Longest-active.** Any active, live session, earliest `activatedAt`. Deliver with claim,
     reason `longest-active session`.
  5. **Otherwise:** `wait`, reason `no active session`.
- `claims.ts`:
  `export type ClaimTarget = { kind: 'thread' | 'task' | 'plan'; key: string };`
  `export function claimTargets(method: RpcMethodName, params: unknown, result: unknown): ClaimTarget[]`.
  - `message.send` and `escalate` claim the thread `result.threadId`.
  - `task.create`, `task.act`, `review.request` and `review.submit` claim the thread
    `result.threadId` (a `TaskDetail`).
  - `plan.start`, `plan.submit` and `plan.cancel` claim the thread `result.threadId` (a `Plan`).
  - `plan.contribute` claims the plan `params.planId`.
  - Every other method claims nothing. Reads never claim.
  - Malformed input claims nothing: wrap the property reads.
- `SessionsRepo` (DB only; bodies are the implementer's): `insert(row)`, `get(id)`,
  `listLive(agentId)` (non-closed), `touch(id, at, git)`, `setActive(id, active, at)`,
  `setDescription(id, text)`, `markAway(id, at)`, `markLive(id)`, `close(id, at, released:
  number[])`, `owner(threadId, agentId): string | null`, `setOwner(threadId, agentId, sessionId,
  at)`, `releaseOwned(sessionId): number[]`, `ownedThreads(sessionId): number[]`, `staleLive(before:
  string)`, `awayBefore(before: string)`.

- [ ] **Step 1: Write the failing tests.**
  - `routing.test.ts` covers one case per rule. Use sessions `s1`/`s2`, both active and live, with
    `activatedAt` `2026-10-21T09:00Z` and `10:00Z`:
    - `delivers to the active thread owner` → `{ kind: 'deliver', sessionId: 's2', claim: false,
      reason: 'owns thread' }` when `threadOwner: 's2'`.
    - `holds for an inactive owner` → `wait`, reason contains `s1`, when s1 is inactive and
      `threadOwner: 's1'`.
    - `holds for an away owner`.
    - `falls back to the parent owner and claims`.
    - `uses the task owner when the thread is unowned`.
    - `owner beats the sender pick` → owner s1, picked s2, delivers to s1.
    - `follows the sender pick for unowned work`.
    - `prefers a session in the message repo` → s1 repo `a/x`, s2 repo `a/y`, repo `a/y`, s2.
    - `falls back to the longest-active session` → s1.
    - `never picks an inactive session by fallback` → only an inactive s1 means
      `wait 'no active session'`.
    - `ignores a closed owner` → `threadOwner: 's9'` (not listed) falls through to the rules.
  - `claims.test.ts`:
    - `message.send` returns `[{ kind: 'thread', key: 'thr-3' }]` for result
      `{ threadId: 'thr-3', … }`.
    - `task.act` claims `thr-9`.
    - `plan.contribute` claims `{ kind: 'plan', key: 'plan-2' }`.
    - `task.get` and `thread.get` return `[]`.
    - A result without `threadId` returns `[]`.
  - Run `pnpm vitest run apps/hub/src/db` for migrate: still applies every version on an empty DB.
- [ ] **Step 2:** Run `pnpm vitest run apps/hub/src/modules/sessions`. Expected: it fails because
  the modules are missing.
- [ ] **Step 3:** Implement the migration, the repo, `routeDelivery` and `claimTargets`.
- [ ] **Step 4:** Run the same command and `pnpm vitest run apps/hub/src/db`. Expected: pass.
- [ ] **Step 5:** Commit `Hub: session tables and pure routing/claim rules`.

### Task 4: Hub — sessions service, session RPCs, router integration

**Files:**

- Create:
  - `apps/hub/src/modules/sessions/sessions.service.ts`
  - `apps/hub/src/modules/sessions/handlers.ts`
  - `apps/hub/src/modules/sessions/index.ts`
  - `apps/hub/src/modules/sessions/sessions.service.test.ts`
  - `apps/hub/src/modules/sessions/version.ts`, containing `isAtLeast(version: string, min:
    string): boolean`. It is a pure, numeric dotted compare; anything unparsable counts as old.
- Modify:
  - `apps/hub/src/contracts.ts`: add `SessionsService` and `SessionRecord`. `CallContext` gains
    `session: string | null` and `notes: string[]`.
  - `MessagingService` gains `markRead(participantId: string, messageIds: string[]): void`.
  - `TaskService` gains `locate(taskId: number): { threadId: number; repo: string | null } | null`.
  - `PlanningService` gains `threadOf(planId: number): number | null`.
  - `apps/hub/src/rpc/router.ts`: verify `ctx.session` and call `recordClaims` after a successful
    handler run.
  - `apps/hub/src/runtime/modules.ts`: build the sessions module after messaging; wire `locate` and
    `threadOf` once tasks and planning exist.
  - `apps/hub/src/modules/presence/handlers.ts`: move `session.hello` and `session.bye` into the
    sessions handlers. The presence module keeps `presence.set` and `peers.list`.
  - `apps/hub/src/modules/presence/peer.ts`: `PeerInfo.sessions` comes from a
    `sessions.activeSessions(agentId)` reader, set like `setLoadReader`.
  - The `markRead`, `locate` and `threadOf` implementations in the messaging, tasks and planning
    services.

**Interfaces:**

- Consumes: Task 3 (`SessionsRepo`, `claimTargets`, `routeDelivery`), Task 1 types.
- Produces (`contracts.ts`):

```ts
export interface SessionRecord { id: string; agentId: string; active: boolean; liveness: 'live' | 'away' | 'closed'; description: string | null; repo: string | null; branch: string | null; createdAt: string; activatedAt: string | null; lastSeen: string }
export interface SessionsService {
  open(agentId: string, input: { clientVersion: string; repo?: string; branch?: string; previousSessionId?: string }): { session: SessionRecord; reclaimed: number[] };
  verify(agentId: string, sessionId: string): SessionRecord;            // not_found "Unknown or closed session <id>; reconnect"
  activate(agentId: string, sessionId: string, description: string): SessionRecord;
  deactivate(agentId: string, sessionId: string): SessionRecord;
  describe(agentId: string, sessionId: string, description: string): SessionRecord;
  close(agentId: string, sessionId: string): void;                      // session.bye
  take(agentId: string, sessionId: string, threadId: number): { previous: string | null };
  recordClaims(call: CallContext, method: RpcMethodName, params: unknown, result: unknown): void;
  view(sessionId: string): SessionView;
  activeSessions(agentId: string): SessionSummary[];
  hasLiveSession(agentId: string): boolean;
  ownerOf(threadId: number, agentId: string): string | null;
}
```

**Behaviour:**

- `open`:
  - Ids come from `newSessionId()` in `packages/common` ids: `s-` plus 12 chars from
    `[a-z0-9]`.
  - A `previousSessionId` that is non-closed and belongs to this agent is reused and touched.
  - A closed one gets a new session. Its `released` threads that are still unowned are reassigned
    to the new session, and their ids are returned as `reclaimed`.
- `recordClaims` (agent callers with a session only):
  - Resolve each `ClaimTarget` to a thread id: tasks through `locate`, plans through `threadOf`.
  - Unowned, or owned by a closed session: set the owner.
  - Owned by another live or away session: keep it, and push this note into `call.notes`, exactly
    this copy:
    `"<thr-x> belongs to your session <id> (“<description or ‘no description’>”); its messages go
    there. Run /agentmesh:take <thr-x> to move it here."`
- `session.hello`:
  - Refuse `clientVersion` below `0.2.0` with `invalid_request` and this copy:
    `"This AgentMesh plugin (<v>) predates per-session delivery. Update it: claude plugin update
    agentmesh@agentmesh, then restart Claude Code."`
  - Otherwise do `presence.touch`, then `sessions.open`, and return the existing result plus
    `sessionId` and `reclaimed` (thread keys).
- `session.bye`:
  - `close` releases ownership and stores `released`.
  - `presence.markOffline` runs only when `!hasLiveSession(agent)`.
- `session.take`:
  - `taskId` resolves through `locate`.
  - The caller must be a participant of the thread; otherwise `forbidden`.
- Router: when `ctx.session` is set and the caller is an agent, call `sessions.verify(caller.id,
  session)` before the handler. After the handler resolves, call `sessions.recordClaims(call,
  method, params, result)`. The router gets `sessions?` in `RouterDeps`.
- The router builds `call` as `{ actor, caller, method, session: ctx.session ?? null, notes:
  ctx.notes ?? [] }`. Pass the same array, so notes added by handlers or `recordClaims` reach the
  response.
- **Atomic claims.**
  - For a method whose `claimTargets` can be non-empty, the router runs the handler and
    `recordClaims` inside one `deps.transaction(() => …)`. `RouterDeps` gains `transaction<T>(fn:
    () => T): T`, wired to `ctx.db.transaction`; nested handler transactions become savepoints.
  - So the action and the ownership it creates commit together, or not at all.
  - Every claiming handler is synchronous today. If one ever returns a promise, the router throws
    `internal`, and a test pins that.
- `activate` and `describe` store `redactSecrets(description)`. Import it from
  `modules/messaging/redact`, which is already shared.

- [ ] **Step 1: Write the failing tests** in `sessions.service.test.ts`, with `createTestHarness`
  plus real messaging, presence and the sessions module:
  - `opens an inactive live session with a hub id` → `active false`, `liveness 'live'`, id matches
    `SESSION_ID_PATTERN`.
  - `verify refuses another agent's session` → `not_found`.
  - `first acting session owns the thread; a second keeps it and gets a note`. Concretely:
    - `recordClaims` from s1 for `message.send` with result `{threadId:'thr-1'}` makes s1 the
      owner;
    - the same from s2 leaves `ownerOf` as s1, and `call.notes[0]` contains
      `/agentmesh:take thr-1`.
  - `take moves ownership and reports the previous owner`.
  - `bye releases ownership; a reconnect reclaims what nobody took`. Concretely:
    - s1 owns thr-1 and thr-2, then closes;
    - s2 claims thr-2;
    - `open({ previousSessionId: s1 })` returns a new session that owns thr-1 only, with
      `reclaimed` `[thr-1's id]`.
  - `hello refuses plugins older than 0.2.0`: `0.1.7` throws `invalid_request`, and the message
    contains `claude plugin update`.
  - `peers list active sessions only`: an inactive session is absent; an active one appears with
    its description and owned task keys.
  - In `apps/hub/src/rpc/router.test.ts`, `router verifies the session and records claims after
    success` uses fake sessions deps.
  - In the same file, `a failing claim rolls back the action`. A fake `recordClaims` throws after
    the handler wrote a row through a real test `Db`, and the row is absent afterwards.
- [ ] **Step 2:** Run `pnpm vitest run apps/hub/src/modules/sessions apps/hub/src/rpc`. Expected:
  fail.
- [ ] **Step 3:** Implement. Keep `sessions.service.ts` under 300 lines: liveness goes to Task 5's
  file.
- [ ] **Step 4:** Run `pnpm check`. Expected: green. The Task 1 typecheck errors are now gone.
- [ ] **Step 5:** Commit `Hub: sessions service, session RPCs and ownership claims`.

### Task 5: Hub — liveness: heartbeats, away, grace, reclaim

**Files:**

- Create: `apps/hub/src/modules/sessions/liveness.ts` and `liveness.test.ts`.
- Modify:
  - `apps/hub/src/modules/presence/listener.ts`: the heartbeat gains
    `session: z.string().max(64).optional()`.
  - `apps/hub/src/modules/sessions/index.ts`: the `sessions.expire` tick.
  - `packages/config/src/schema/policy.ts`: in `presence`, add `ownershipGraceMinutes:
    z.number().int().min(1).default(120)`.
  - `config/examples/mesh.yaml`: commented.
  - `docs/configuration.md`.

**Interfaces (produces):**

- `SessionsService` additions:
  - `touch(agentId: string, sessionId: string, git?: { repo?: string; branch?: string }): 'ok' |
    'unknown'`. An away session becomes live again with its ownership intact; a closed or foreign
    session returns `'unknown'`.
  - `unreachable(sessionId: string): void` marks the session away now.
  - `expire(now: Date): { away: number; closed: number }`:
    - live sessions not seen for `presence.offlineAfterSeconds` become away;
    - away sessions older than `ownershipGraceMinutes` close, which releases ownership and fills
      `released`.
- `startPresenceListener(nc, prefix, presence, logger, onSession?: (agentId, sessionId, git) =>
  'ok' | 'unknown', onUnknown?: (agentId, sessionId) => void)`. When a heartbeat carries `session`,
  call `onSession`. On `'unknown'`, call `onUnknown`; Task 8 wires it to publish
  `{ type: 'expired' }`.

- [ ] **Step 1: Write the failing tests** in `liveness.test.ts`, driving time with `ManualClock`:
  - `a silent session goes away but keeps its work`: after `clock.advance(76_000)` and `expire`,
    liveness is `'away'` and `ownerOf(thr-1)` is still s1.
  - `a heartbeat brings an away session back with its work`.
  - `after the grace period the session closes and releases its work`: `advance(121 * 60_000)`
    gives liveness `'closed'` and `ownerOf` null.
  - `touch reports unknown for a closed or foreign session`.
  - `unreachable marks away immediately`.
  - In `listener` tests (extend the existing ones): `parseHeartbeat` keeps `session`.
  - Config: `ownershipGraceMinutes defaults to 120`, in the config package tests.
- [ ] **Step 2:** Run `pnpm vitest run apps/hub/src/modules/sessions packages/config`. Expected:
  fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm check`. Expected: green.
- [ ] **Step 5:** Commit `Hub: sessions go away on silence and close after a grace period`.

### Task 6: Hub — routed delivery through the outbox

**Files:**

- Create:
  - `apps/hub/src/modules/sessions/dispatcher.ts`, holding `SessionDispatcher` and the
    `SessionTransport` interface.
  - `apps/hub/src/modules/sessions/dispatcher.test.ts`.
- Modify:
  - `apps/hub/src/ports.ts`: `DeliveryPort.deliver(recipientId: string, messages: MeshMessage[]):
    Promise<DeliveryReceipt>`, where `DeliveryReceipt = { delivered: string[]; commit?: () =>
    void }`.
    - `commit` holds the follow-up database writes for the delivered messages. It is synchronous,
      DB only, and runs inside the outbox's transaction.
    - `MemoryPorts` records each message and returns `{ delivered: every id }`.
  - `apps/hub/src/core/outbox.ts`: group pending rows by recipient, oldest first, and call
    `deliver` once per recipient. Run the recipients concurrently with `Promise.allSettled`, so one
    slow or dead session never delays another agent's messages.
    - In one `db.transaction`, mark the returned ids published and run `receipt.commit?.()`. If
      that throws, nothing is marked and the rows are retried. The plugin drops the redelivered ids
      it already pushed.
    - Leave the rest pending, without incrementing `attempts`.
    - On a throw, increment `attempts` and record `last_error`.
    - Remove the per-recipient blocking; per-thread order is now the dispatcher's job.
  - `apps/hub/src/core/outbox.test.ts`.
  - `apps/hub/src/testing/services.ts`: `drain` still works.

**Interfaces:**

- Consumes:
  - `SessionsService.route`. Add it in this task: `route(agentId: string, message: MeshMessage):
    Route` builds `RouteInput` from the repo, `messaging.thread(id).parentId`, `refs.taskId` (via
    `locate`), `refs.session` and `refs.repo` (else the task's repo).
  - `SessionsService.delivered(agentId, sessionId, message, route)` sets the thread owner when
    `route.claim`.
  - `unreachable`.
  - `MessagingService.markRead`.
- Produces:

```ts
export interface SessionTransport {
  /** Hands messages to one session; resolves with the ids it pushed into Claude Code. */
  send(agentId: string, sessionId: string, messages: MeshMessage[]): Promise<string[]>;
  /** Tells a plugin its session is gone so it says hello again. */
  expired(agentId: string, sessionId: string): void;
}
export class SessionDispatcher implements DeliveryPort {
  constructor(deps: { sessions: SessionsService; messaging: MessagingService; transport: SessionTransport; logger: Logger });
  deliver(agentId: string, messages: MeshMessage[]): Promise<DeliveryReceipt>;
}
```

**Algorithm (the tests don't fully determine it):**

1. Route the messages in order.
2. Once a thread's message waits, every later message of that thread waits too.
3. Group the `deliver` routes by session, keeping the order.
4. Start every session's `transport.send` before awaiting any, then await them with
   `Promise.allSettled`. For each session:
   - On a throw: `sessions.unreachable(sessionId)`, log `warn` with the session id and reason
     (never message bodies), and skip.
   - On success, collect the acked messages with their routes. Write nothing yet.
5. Log each routing decision at `debug` as `{ agent, message, session, reason }`.
6. Return `{ delivered: ackedIds, commit }`. `commit` calls `sessions.delivered(...)` for each acked
   message, which claims ownership when `route.claim`, then `messaging.markRead(agentId, ackedIds)`.
   - The outbox runs `commit` in the same transaction that marks the rows published.
   - So "delivered", "read" and "owned" are one atomic step: there is no dual write.

- [ ] **Step 1: Write the failing tests** in `dispatcher.test.ts`. Use `createServiceHarness`, the
  real sessions module and `FakeTransport`, which records sends and can ack a subset or throw:
  - `never delivers to an agent whose only session is inactive`: the result is `[]`, the transport
    is not called, and the outbox row stays pending.
  - `a new conversation sticks to the chosen session`:
    - s1 is active at 09:00 and s2 at 10:00;
    - an ask to the agent goes to s1, longest-active;
    - s2 then sets repo-matching state, and the next message in that thread still goes to s1
      ("owns thread").
  - `delivery marks the message read`: `unreadThreadCount(agent)` goes from 1 to 0 after an ack.
  - `a partly acked batch publishes the acked ids and keeps the rest`: the transport acks 2 of 3,
    then a second flush sends only the third.
  - `an unreachable session goes away and its work waits`.
  - `a dead session does not hold up other sessions`:
    - s1's send returns a promise the test controls and leaves pending;
    - s2's send is recorded before s1's promise settles;
    - after rejecting s1, s2's ids are returned and s1 is away.
  - `outbox.test.ts`: `a failing recipient does not delay another recipient`. MemoryPorts
    `failNext` is scoped to one recipient; the other recipient's rows are published in the same
    flush.
  - `routing survives a hub restart`: build a second `SessionsServiceImpl` over the same `ctx.db`,
    and `route` for the next message in thr-1 still returns s1.
  - `outbox.test.ts`: `returned ids are published and the rest stay pending`.
  - `outbox.test.ts`: `a failing commit marks nothing and retries`. When `commit` throws, the rows
    stay pending and the read cursor and owner are unchanged. The next flush delivers again, and
    the second `commit` succeeds.
- [ ] **Step 2:** Run `pnpm vitest run apps/hub/src/modules/sessions apps/hub/src/core`. Expected:
  fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm check`. Expected: green, and existing tests using `ports.deliveries`
  are unchanged.
- [ ] **Step 5:** Commit `Hub: deliver through the outbox to the session that owns the work`.

### Task 7: Hub — read state follows what the session saw

**Files:**

- Modify:
  - `apps/hub/src/modules/messaging/post.ts`: delete `pc.reads.advance(thread.id,
    input.senderId, seq)`. The sender is already excluded by `UNREAD`.
  - `apps/hub/src/modules/messaging/thread.handlers.ts`: `thread.get` advances the cursor only
    when the call has no session, or the session owns the thread, or nobody owns it.
  - `apps/hub/src/modules/messaging/inbox.ts`: `readInbox(…, sessionId: string | null)` returns
    threads owned by this session or by nobody. Report the rest as `otherSessions: number`, and
    leave them unread.
  - `packages/protocol/src/rpc/messaging.ts`: the `inbox.get` result gains
    `otherSessions: z.number().int().nonnegative().default(0)`.
  - `plugins/agentmesh/src/tools/messaging.ts`: `inbox` appends `"(<n> unread thread(s) belong to
    your other sessions)"` when n > 0.
  - The messaging deps get `ownerOf(threadId, agentId)`, wired from sessions in `modules.ts`.
- Test: `apps/hub/src/modules/messaging/messaging.test.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `a reply does not mark earlier unseen messages read`:
    - alice asks bob twice in thr-1;
    - bob replies once through `post`;
    - bob's `unreadThreadCount` is still 1, with both asks unread.
  - `reading another session's thread leaves it unread`.
  - `the inbox shows this session's and unowned threads and counts the rest`.
- [ ] **Step 2:** Run `pnpm vitest run apps/hub/src/modules/messaging`. Expected: fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm check`. Expected: green.
- [ ] **Step 5:** Commit `Hub: replies and other sessions' reads no longer mark messages read`.

### Task 8: Hub — NATS session transport; retire the JetStream agent inbox

**Files:**

- Create: `apps/hub/src/modules/sessions/nats-transport.ts` (`NatsSessionTransport implements
  SessionTransport`).
- Modify:
  - `apps/hub/src/app.ts`. In production, `delivery` is a forwarding port to the
    `SessionDispatcher` built after `buildModules`. `NatsPorts` keeps only `publish`. Wire the
    presence listener's `onSession`/`onUnknown`.
  - `apps/hub/src/core/nats-ports.ts`.
  - `apps/hub/src/runtime/nats.ts`: `provisionTopology` stops creating agent inbox consumers and
    deletes a leftover `{P}_DELIVERY` stream, best-effort, logged once.
  - `packages/bus/src/topology.ts`: remove the delivery stream and `ensureInboxConsumer`/
    `deleteInboxConsumer`; add `removeLegacyDelivery(jsm, prefix)`.
  - `packages/protocol/src/subjects.ts`: remove `deliver`/`deliverAll` and `consumerNames.inbox`.
  - The enrollment module: remove `InboxPort` and its calls. Members joining or leaving no longer
    touch JetStream.
  - Any test that referenced these.

**Interfaces:**

- `NatsSessionTransport(nc, prefix, logger, timeoutMs = 5000)`:
  - `send` requests `subjects.session(agent, session)` with body `{ type: 'deliver', messages }`,
    options `{ timeout, noMux: true, reply: subjects.ack(agent, randomToken()) }`.
    - It parses the reply with `SessionAck` and returns the delivered ids that were sent.
    - Timeouts and no-responders throw.
  - `expired` publishes `{ type: 'expired' }`.
- The hub subscribes to nothing new. The reply subject is the request's own `noMux` inbox, and the
  agent's publish permission on `{p}.ack.{agent}.>` lets the plugin answer it.

- [ ] **Step 1: Write the failing test.** In `apps/hub/src/app.test.ts`:
  `createHub without NATS still delivers through the injected ports`, to guard the wiring.
  Transport behaviour is proven end to end in Task 11.
- [ ] **Step 2:** Run `pnpm vitest run apps/hub`. Expected: fail where the old delivery or inbox
  APIs are referenced.
- [ ] **Step 3:** Implement and remove the dead code. Search with `Grep` for `deliver(`,
  `ensureInboxConsumer`, `consumerNames.inbox` and `InboxPort`; every hit is either removed or
  updated.
- [ ] **Step 4:** Run `pnpm check`. Expected: green.
- [ ] **Step 5:** Commit `Hub: hand deliveries to sessions over NATS; retire the JetStream agent
  inbox`.

### Task 9: Plugin — session-aware hub client and inbox

**Files:**

- Create:
  - `plugins/agentmesh/src/inbox/session-inbox.ts` (`runSessionInbox`)
  - `plugins/agentmesh/src/inbox/recent-ids.ts` (move `RecentIds` here)
  - `plugins/agentmesh/src/inbox/session-inbox.test.ts`
- Delete: `plugins/agentmesh/src/inbox/consumer.ts` and the `Coalescer` in `coalescer.ts`; the hub
  batches now.
- Modify:
  - `plugins/agentmesh/src/hub.ts`:
    - `sessionId: string | null`;
    - `call` passes `session` and collects notes;
    - add `takeNotes(): string[]`.
  - `plugins/agentmesh/src/session.ts`:
    - hello with `previousSessionId`;
    - start the session inbox;
    - re-hello on `expired`, or on an RPC error whose message starts with `Unknown or closed
      session`.
  - `plugins/agentmesh/src/presence.ts`: the heartbeat body includes `session`.
  - `plugins/agentmesh/src/inbox/inbox.test.ts`.

**Interfaces:**

```ts
export interface SessionInboxOptions {
  hub: HubClient; logger: Logger; signal: AbortSignal;
  push(event: ChannelEvent): Promise<void>;
  onExpired(): void;
}
/** Subscribes to {p}.session.{agent}.{session}; for 'deliver' pushes one event per thread (renderEvent) in order and replies SessionAck with the ids whose push succeeded (ids already in RecentIds are acked without pushing). */
export function runSessionInbox(options: SessionInboxOptions): { stop(): void; resubscribe(): void };
```

- [ ] **Step 1: Write the failing tests** in `session-inbox.test.ts`, with a fake NATS msg carrying
  `respond`:
  - `pushes one event per thread and acks every pushed id`: 3 messages in 2 threads give 2 pushes,
    and the ack lists all 3 ids.
  - `does not ack messages whose push failed`: the second thread's push throws, so the ack holds
    only the first thread's ids.
  - `acks a redelivered id without pushing it again`.
  - `calls onExpired for an expiry notice`.
  - `ignores malformed payloads`: no reply and no throw.
  - In the `hub` tests: `takeNotes returns and clears notes from the last calls`.
- [ ] **Step 2:** Run `pnpm vitest run plugins/agentmesh`. Expected: fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm check`. Expected: green.
- [ ] **Step 5:** Commit `Plugin: one hub session per process; deliveries acked only once pushed`.

### Task 10: Plugin — activation, session tools, slash commands, release 0.2.0

**Files:**

- Create:
  - `plugins/agentmesh/src/tools/sessions.ts` (tools `activate`, `deactivate`,
    `describe_session`, `take`)
  - `plugins/agentmesh/src/tools/activation.ts` (`ActivationCheck`)
  - `plugins/agentmesh/skills/activate/SKILL.md`
  - `plugins/agentmesh/skills/deactivate/SKILL.md`
  - `plugins/agentmesh/skills/take/SKILL.md`
- Modify:
  - `plugins/agentmesh/src/tools/types.ts`: `ToolDeps` gains `push(event: ChannelEvent):
    Promise<void>` and `activation: ActivationCheck`.
  - `plugins/agentmesh/src/tools/registry.ts`: add `sessionTools`, and append `hub.takeNotes()` to
    each result as a trailing block.
  - `plugins/agentmesh/src/tools/messaging.ts`: `ask` gains `to_session` and `repo`, mapped to
    `toSession`/`repo`.
  - `plugins/agentmesh/src/tools/format.ts`: `formatPeers` prints each active session as
    `    · <id> — <description> (<repo>@<branch>) owns <tasks>`.
  - `plugins/agentmesh/src/main.ts`: build `ToolDeps` with `push` and `activation`.
  - `plugins/agentmesh/src/instructions.ts`, with its test.
  - Version `0.2.0` in the three places.
  - `plugins/agentmesh/dist/server.js`, rebuilt.

**Interfaces:**

- `ActivationCheck`: `issue(): string` returns a 6-character code from `[A-Z2-9]` and replaces any
  earlier one. `verify(code: string): boolean` accepts only the latest code, within 10 minutes.
- Tool `activate`, input `{ code?: string; description?: string }`:
  - **No code:** call `issue()`, then push this event: content
    ``AgentMesh activation check. Code: <CODE>. To finish, call activate(code: "<CODE>",
    description: "<one line: what this session is working on>").`` with meta `{ kind: 'system',
    from: 'agentmesh' }`. Return:
    `"Sent a test message to this session. If it arrives, call activate again with its code and a
    one-line description. If nothing arrives within a few seconds, this session was started without
    the channel flag: restart it with claude --dangerously-load-development-channels
    plugin:agentmesh@agentmesh."`
  - **A code that verifies, with a description:** call `session.activate` and return
    `"This session is active on the mesh as “<description>”."`
  - **A wrong or stale code:** return an error.
  - **A good code without a description:** return an error asking for one.
  - Tool description: `Turn this session on for the mesh, only when your human asks
    (/agentmesh:activate). Until then it receives nothing.`
- `deactivate`, `describe_session` (`description`) and `take` (`task_id` | `thread_id`) map to the
  RPCs.
- Each `SKILL.md` has frontmatter `disable-model-invocation: true` and tells Claude which tool to
  call:
  - `/agentmesh:activate`: call `activate`, wait for the code, call again with the code and a
    one-line description written from the current conversation. Later, call `describe_session`
    whenever the session's focus changes.
  - `/agentmesh:deactivate`.
  - `/agentmesh:take <task or thread>`.
- The instructions gain this line, after the identity line:
  `"This session receives mesh messages only after your human runs /agentmesh:activate; until then
  the tools still work and answers wait for this session."` The 4096-character test must still
  pass.

- [ ] **Step 1: Write the failing tests** in `tools.test.ts`:
  - `activate without a code pushes a check and explains the channel flag`.
  - `activate with the pushed code and a description activates the session` (the fake hub records
    `session.activate`).
  - `activate refuses a wrong code`.
  - `tool results end with hub notes`.
  - `ask passes to_session and repo`.
  - `peers prints active sessions`.
  - `instructions.test.ts`: `mentions /agentmesh:activate and stays under 4096`.
- [ ] **Step 2:** Run `pnpm vitest run plugins/agentmesh`. Expected: fail.
- [ ] **Step 3:** Implement. Bump to `0.2.0`, then run `pnpm --filter agentmesh build`.
- [ ] **Step 4:** Run `pnpm check`. Expected: green. `git status` shows `dist/server.js` changed.
- [ ] **Step 5:** Commit `Plugin 0.2.0: opt-in sessions (/agentmesh:activate), take, session
  picks`.

### Task 11: End to end over NATS

**Files:**

- Modify:
  - `tests/integration/support.ts`: add `activate(agent: Agent, description: string):
    Promise<void>`. It calls `activate`, waits for the event whose content contains `Code:`, and
    calls `activate` with that code.
  - Every existing e2e test: activate each spawned agent before it expects pushes.
- Create: `tests/integration/sessions.e2e.test.ts`.

**Setup:** download nats-server 2.15.1 for Windows into
`C:\Users\USER\AppData\Local\Temp\claude\G--Projects-AgentMesh\ff8e5fc7-c52b-4b7f-b5ca-abbddf886f2b\scratchpad\nats`
from
`https://github.com/nats-io/nats-server/releases/download/v2.15.1/nats-server-v2.15.1-windows-amd64.zip`.
Run with that folder prepended to `PATH`. The tests start their own server on their own port;
never stop another nats-server process.

- [ ] **Step 1: Write the failing tests** in `sessions.e2e.test.ts`:
  - `an inactive session of the same agent never receives`:
    - spawn `bob-agent` twice, activating only the second;
    - alice asks bob;
    - the second gets the push, and the first gets no channel event within 3 s.
  - `the answer comes back to the session that asked`:
    - alice runs two active sessions, a1 (activated first) and a2;
    - a2 asks bob, and bob replies;
    - a2 gets the answer, and a1 gets nothing within 3 s.
  - `a message waits while no session is active and arrives on activation`.
  - `pre-0.2.0 plugins are told to update`: call `session.hello` with `clientVersion: '0.1.7'` over
    a raw `RpcClient` and expect `invalid_request`.
- [ ] **Step 2:** Run `pnpm build`, then `pnpm test:integration` with the scratch nats-server on
  `PATH`. Expected: the new tests fail before Tasks 1–10 are in place and pass after. If running
  after Task 10, run them to confirm they pass.
- [ ] **Step 3:** Fix whatever the e2e run exposes, at the root cause and in the shared function,
  with a unit test that fails without the fix.
- [ ] **Step 4:** Run `pnpm check` and `pnpm test:integration`. Expected: both green, with 0
  integration tests skipped while nats-server is on `PATH`.
- [ ] **Step 5:** Commit `E2E: per-session delivery, opt-in activation, sticky answers`.

### Task 12: Docs, ADR, threat note

**Files:**

- Create: `docs/adr/0006-per-session-delivery.md`. Status accepted; it supersedes ADR 0001's
  per-agent inbox consumer.
- Modify:
  - `docs/protocol.md`: session subjects, envelope `session`/`notes`, session RPCs, the delivery
    request/ack, routing rules with their reasons.
  - `docs/security.md`: the threat note.
  - `docs/getting-started.md`: start with the channel flag, then `/agentmesh:activate`.
  - `docs/configuration.md`: done in Task 5; verify it.
  - `plugins/agentmesh/README.md`.
  - `CLAUDE.md`, the "Working on this repo" bullets that mention the inbox consumer.
  - `docs/specs/2026-10-21-session-routing-design.md`: Status gets "Part A built (plan 1)".

**What the ADR records:**

- **Context:** the 2026-10-20 losses.
- **Decision:**
  - The hub's outbox is the agent queue.
  - Core NATS request/ack goes to `{p}.session.{agent}.{session}`, with replies on
    `{p}.ack.{agent}.>`.
  - The `{P}_DELIVERY` stream is removed.
- **Consequences:**
  - The transactional outbox is kept end to end, so there is no dual write:
    - **Producer side:** the state change and its deliveries and events commit in one SQLite
      transaction, as before.
    - **Consumer side:** "published", "read" and "owned" commit in one transaction after the
      plugin's ack.
    - **Claims:** an RPC's action and the ownership it creates commit in one transaction.
  - Delivery is at-least-once. A hub crash between the plugin's push and the commit redelivers;
    the plugin drops ids it already pushed. Only a plugin restart in that same window can show a
    message twice. Nothing is lost.
  - Delivery needs the hub up; it always did for RPCs.
  - Sessions of one agent share NATS permissions.
  - A routing decision is logged with its reason.
- **Alternatives:**
  - per-session JetStream consumers, rejected because permissions can't scope per-session consumer
    names;
  - `allow_responses`, rejected because it differs between static config and callout JWTs.

**What the threat note covers:**

- **Shared permissions.** Any process holding the agent's key can subscribe to every session of
  that agent; isolation between one person's sessions is not a goal.
- **Who may activate.** Activation proves the channel works, not human intent. The tool
  description and the user-only slash command are the guard. With the `mcp__plugin_agentmesh_mesh__*`
  allow rule, Claude could activate on its own.
- **Descriptions** are redacted and team-visible.
- **Ack replies** are permission-scoped to `{p}.ack.{agent}.>`, so one agent cannot ack another's
  deliveries.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Run `pnpm check`. Expected: green. Docs are not size-checked, but links must
  resolve: run `Grep` for each new relative link target.
- [ ] **Step 3:** Commit `Docs: ADR 0006 per-session delivery, protocol, threat note, setup`.

---

## After plan 1

- Ask Pratik before pushing `agent/pratik/session-routing` and opening the PR into `agents`.
- Deploying needs every teammate's plugin at `0.2.0` at the same time as the hub; the hub refuses
  older plugins. Coordinate that with Pratik.
- Then write plans 2 and 3 against the merged interfaces: `CallContext.notes`, `SessionsService`,
  `SessionDispatcher`, `RpcResponseEnvelope.notes`.
