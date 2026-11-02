# Mesh window, plan 1: reads and ownership — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session that isn't activated can no longer take team work by reading. Pause stops
reads from taking work. Tasks handed out from a private session belong to the agent's active
sessions. These are the fixes behind Aheen's lost request.

**Architecture:**
- **Reads.** One late-bound check from messaging into sessions decides whether a session may take
  unowned threads. `inbox.get`, `inbox.peek` and `thread.get` all go through it.
- **Claims.**
  - An active session's `inbox.get` claims the action threads it returns (pure `claims.ts`).
  - An inactive session's actions claim only its own conversations.
  - Routing skips an inactive owner reached through a parent thread or a task (pure `chainOwner`).
- Hub-first. The plugin only changes the `inbox` tool's text.

**Tech Stack:**
- Node 24 (`node:sqlite`), TypeScript 7, zod 4, vitest 5, Biome 2, pnpm 10.
- The hub is in `apps/hub`, the wire contract in `packages/protocol`, the plugin in `plugins/agentmesh`.

**Spec:** `docs/specs/2026-11-01-mesh-window-design.md`: §4 (reads), §5 "Tasks belong to the
mesh window", §8 (security), §10 (constraints). Plans 2 (the mesh window) and 3 (the relay) come
later.

**Where to work:**
- The worktree `G:\Projects\AgentMesh-meshwindow`, on branch `agent/pratik/mesh-window`.
- Commit after each task. **Never push.** Pratik pushes and merges.

## Global Constraints

- **Size and checks.** No source or test file may go over 300 lines (`pnpm check:size`).
  `pnpm check` must pass after every task.
- **Logic placement.** Routing and claim logic stay pure functions with unit tests. Modules talk only
  through services and late-bound readers, never through each other's tables.
- **Root-cause fixes.** Every fix lands in the shared function, with a test that fails without it
  (CLAUDE.md).
- **Protocol fields are additive** with `.default(...)`, so old plugins keep parsing results.
- **Version bump:** `packages/common/src/version.ts` plus the 9 workspace `package.json` files plus
  `plugins/agentmesh/.claude-plugin/plugin.json`. `version.test.ts` pins them together.
- **Plugin dist.** Rebuild `plugins/agentmesh/dist/*` with `pnpm --filter @agentmesh/plugin build`,
  and commit the dist.
- **Windows dev box.**
  - `python3` is a stub, so use node.
  - Edit files with the editor tools, not bash heredocs.
- **Integration tests skip silently without nats-server.** To run them:
  1. Start `C:\Users\USER\AppData\Local\Temp\claude\G--Projects-AgentMesh\01d905da-504d-4369-91a5-bb8bb09a37e4\scratchpad\nats-bin\nats-server-v2.15.1-windows-amd64\nats-server.exe -js -p 4333 -sd <scratch dir>`.
  2. Run with `AGENTMESH_TEST_NATS_BIN=<that exe>` and `AGENTMESH_TEST_NATS=nats://127.0.0.1:4333`.

## Review Focus

1. **A session closed or evicted between the router's check and the read.** The read check must
   answer "can't take" and must not throw. Test in Task 1.
2. **A pull session while the agent's push session is *away*.** The push session isn't ready, so the
   pull session may take the work. Test in Task 1.
3. **A human or service reading a thread** (no session) is unaffected, during pause too. Test in
   Task 2.
4. **A malformed `inbox.get` result** reaching `claimTargets` (no array, missing ids) claims nothing
   and never throws. Test in Task 3.
5. **A private session's reply in its own conversation** after this change still makes it the owner,
   so its answers keep coming back to it. Test in Task 4.

---

### Task 1: Reads by a session that can't take unowned work leave it waiting

**Files:**
- Create: `apps/hub/src/modules/sessions/readers.ts`
- Create: `apps/hub/src/modules/sessions/readers.test.ts`
- Modify: `packages/protocol/src/rpc/messaging.ts` (`inbox.get` and `inbox.peek` results)
- Modify: `apps/hub/src/modules/messaging/messaging.service.ts` (`MessagingDeps`)
- Modify: `apps/hub/src/modules/messaging/inbox.ts` (`selectUnread`, `readInbox`, `peekInbox`)
- Modify: `apps/hub/src/runtime/modules.ts` (wiring, about lines 82-102)
- Modify: `apps/hub/src/testing/services.ts` (`createServiceHarness` option; `createDispatchHarness` wiring)
- Test: `apps/hub/src/modules/messaging/messaging.reads.test.ts`
- Test: `apps/hub/src/modules/sessions/pull.test.ts`
- Test: `apps/hub/src/modules/sessions/dispatcher.test.ts`

**Interfaces:**
- **Produces:**
  - `MessagingDeps.mayTakeUnowned(agentId: string, sessionId: string): boolean`.
  - In `readers.ts`:
    - `takeUnownedReader(sessions: () => SessionsService | undefined): (agentId: string, sessionId: string) => boolean`.
      It returns true only when the session exists, isn't closed, is active, and either delivers by
      push or `!sessions.hasReadySession(agentId)`. It returns false, never throws, when
      `verify` throws.
    - `ownerReader(sessions: SessionsService): (threadId: number, agentId: string) => ThreadOwner | null`.
      This moves the body out of `runtime/modules.ts`.
  - `inbox.get` result gains `waiting: number` (default 0) and `paused: boolean` (default false).
    `inbox.peek` result gains `waiting: number` (default 0). `waiting` counts the unread threads
    nobody owns that this session may not take.
  - `createServiceHarness(loaded?, { online?, delivery?, mayTakeUnowned? })`. The new option defaults
    to `() => true`.

- [ ] **Step 1: Baseline**

  Run `pnpm install`, then `pnpm check`. Expected: PASS. Record the test count.

- [ ] **Step 2: Write the failing tests**
  - `readers.test.ts`, using `createDispatchHarness()` and its `sessions`.
    `const take = takeUnownedReader(() => sessions)`:
    - `it('lets an active push session take unowned work')`: `expect(take('bob-agent', push)).toBe(true)`.
    - `it('refuses an inactive session')`: `expect(take('bob-agent', opened)).toBe(false)`.
    - `it('lets a pull session take only while no push session is ready')`: false with a live active
      push session; true after `sessions.unreachable(pushId)`, which makes it away.
    - `it('answers false for a closed or unknown session instead of throwing')`:
      `take('bob-agent', 's-zzzzzzzzzzzz')` returns false.
  - `messaging.reads.test.ts`:
    - `it("an inactive session's inbox leaves unowned threads unread and counts them as waiting")`:
      harness with `mayTakeUnowned: () => false`, three unowned threads, and
      `inbox.get(call('ses_1'))`. Expect:
      - `threads` to equal `[]`;
      - `waiting` to be `3`;
      - `unreadThreadCount('bob-agent')` to still be `3`.
    - `it("an inactive session still reads the threads it owns")`: owners has `t → ses_1`, and
      `inbox.get(ses_1)` returns that thread.
    - `it('peek counts only what this session may take and reports the rest as waiting')`: one
      owned thread and two unowned. `peek(ses_1)` gives `threads: 1`, `waiting: 2`.
  - `pull.test.ts`:
    - `it('take unowned work only while no push session is ready')`: `pull()`, then `active()`, then
      three asks. `peek(s).threads` is `0` and `peek(s).waiting` is `3`, and
      `readInbox(..., s, ...)` returns no threads.
  - `dispatcher.test.ts`: replace `'messages read through inbox are published without a push'`
    with `it('an inactive session reading the inbox leaves the work for an active one')`:
    1. `s1` is opened but not activated. Call `readInbox(…, s1, …)`.
    2. `pending()` still has both ids.
    3. `activate(s1)`, then `outbox.flush()`.
    4. `transport.sends` has `s1` with both ids, and `sessions.ownerOf(t1, 'bob-agent')` is `s1`.

- [ ] **Step 3: Run the tests to make sure they fail**

  Run `pnpm vitest run apps/hub/src/modules/sessions apps/hub/src/modules/messaging`. Expected: the
  new tests FAIL (`waiting` is undefined, unowned threads are returned, `readers.ts` is missing).

- [ ] **Step 4: Implement**
  - **Protocol fields:** `waiting: z.number().int().nonnegative().default(0)` and
    `paused: z.boolean().default(false)`, each with a one-line doc comment.
  - **`readers.ts`:** both readers. `runtime/modules.ts` uses them. `MessagingDeps` gains
    `mayTakeUnowned`.
  - **`inbox.ts`:**
    - `export function mayTakeUnowned(messaging, participantId, sessionId: string | null): boolean`
      returns `sessionId === null || messaging.deps.mayTakeUnowned(participantId, sessionId)`.
    - `selectUnread` returns `{ unread, otherSessions, waiting }`. An unowned thread is included
      only if `mayTakeUnowned`; otherwise it adds to `waiting`.
    - `readInbox` and `peekInbox` return `waiting`, and `readInbox` returns `paused: false` until
      Task 2.
  - **Harnesses:**
    - `createServiceHarness` passes `options.mayTakeUnowned ?? (() => true)`.
    - `createDispatchHarness` wires `takeUnownedReader(() => sessions)` and
      `h.messaging.setOwnerReader(ownerReader(sessions))`.

- [ ] **Step 5: Run the tests and make sure they pass**

  Run `pnpm check`. Expected: PASS. `app.test.ts` must stay green. If an existing test changes
  meaning (for example one that relied on the owner reader being unwired), fix the test's setup, not
  the rule, and say so in the commit.

- [ ] **Step 6: Commit**

  `git commit -m "Hub: a session that may not take unowned work only counts it as waiting"`, plus
  the attribution line.

---

### Task 2: `thread` only looks at threads you don't own, and pause stops all consuming

**Files:**
- Modify: `apps/hub/src/modules/messaging/thread.handlers.ts` (`thread.get`, about lines 21-42)
- Modify: `apps/hub/src/modules/messaging/inbox.ts` (`readInbox`: no advance while paused)
- Test: `apps/hub/src/modules/messaging/messaging.reads.test.ts`

**Interfaces:**
- **Consumes:** `MessagingDeps.control.isPaused()` and Task 1's fields.
- **Produces:**
  - **`thread.get`** marks read only when `call.session === null`, or when the effective owner is
    the caller's session and the mesh isn't paused.
  - **`readInbox`** returns `paused: true` and advances nothing while paused, but still returns the
    threads, so the read only looks.

- [ ] **Step 1: Write the failing tests** (`messaging.reads.test.ts`)
  - `it('a session that does not own an unowned thread only looks at it')`:
    `thread.get(call('ses_2'))` on an unowned thread leaves `unreadThreadCount` at `1`.
  - `it('a caller without a session still marks what it reads')`:
    `thread.get(call(null))` brings it to `0`.
  - `it('while paused, inbox and thread only look')`:
    1. `h.control.pause('aheen', null)`.
    2. The owner reads with `inbox.get(ses_1)`. The result has `paused: true` and contains the
       thread, and `unreadThreadCount` is unchanged.
    3. `thread.get(ses_1)` leaves it unchanged too.
    4. Then `h.control.resume(...)` (see `control.service.ts` for the signature), and
       `inbox.get(ses_1)` marks it read.
  - `it('while paused, a caller without a session still marks what it reads')`.
  - Keep `"reading another session's thread leaves it unread"` as it is.

- [ ] **Step 2: Run the tests to make sure they fail**

  Run `pnpm vitest run apps/hub/src/modules/messaging`. Expected: the first and third new tests
  FAIL.

- [ ] **Step 3: Implement** the rule in `thread.get` (`mayMarkRead`), and the pause guard in
  `readInbox` (skip `reads.advance`, set `paused`). Update both doc comments, which say "Reading
  advances a participant's cursor, unless another session owns the thread".

- [ ] **Step 4: Run the tests and make sure they pass**

  Run `pnpm check`. Expected: PASS. `sessions.service.test.ts` (the parent-owner `thread.get` case)
  must stay green.

- [ ] **Step 5: Commit** `"Hub: thread only looks at threads you don't own; pause stops reads from consuming"`.

---

### Task 3: An active session's inbox read claims the action threads it returns

**Files:**
- Modify: `apps/hub/src/modules/sessions/claims.ts`
- Modify: `apps/hub/src/rpc/rate-limit.ts` (only the comment above `FREE`: `inbox.get` now records
  ownership, but stays free)
- Test: `apps/hub/src/modules/sessions/claims.test.ts`
- Test: `apps/hub/src/modules/sessions/readers.test.ts` (the end-to-end claim through
  `sessions.recordClaims`)

**Interfaces:**
- **Consumes:** the `inbox.get` result shape from Task 1 (`threads[].thread.id`, `threads[].fyi`,
  `paused`).
- **Produces:**
  - `isClaiming('inbox.get') === true`.
  - `claimTargets('inbox.get', params, result)` returns `{ kind: 'thread', key }` for each returned
    thread with `fyi === false`. It returns `[]` when `result.paused === true`, or for a malformed
    result. It never throws.

- [ ] **Step 1: Write the failing tests** (`claims.test.ts`)
  - `it('claims the action threads an inbox read returns, not the FYI ones')`:
    `claimTargets('inbox.get', {}, { threads: [{ thread: { id: 'thr-1' }, fyi: false }, { thread: { id: 'thr-2' }, fyi: true }], paused: false })`
    equals `[{ kind: 'thread', key: 'thr-1' }]`.
  - `it('claims nothing for a paused inbox read')`.
  - Add these cases to `'claims nothing for malformed input'`:
    - `claimTargets('inbox.get', {}, { threads: 'x' })` gives `[]`;
    - `claimTargets('inbox.get', {}, { threads: [{ fyi: false }] })` gives `[]`;
    - `claimTargets('inbox.get', {}, null)` gives `[]`.
  - The `'isClaiming covers exactly…'` fixture result becomes
    `{ threadId: 'thr-1', threads: [{ thread: { id: 'thr-1' }, fyi: false }] }`.
  - **End to end,** in `readers.test.ts`:
    `it("an active session's inbox read makes it the owner of what it took")`:
    1. Use `readInbox` for active push `s`.
    2. Call `sessions.recordClaims(call, 'inbox.get', {}, result)`.
    3. Expect `sessions.ownerOf(t, 'bob-agent')` to be `s`.

- [ ] **Step 2: Run the tests to make sure they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** in `claims.ts`, guarding shapes the same way the existing `str()`
  helper does.
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `"Hub: an active session's inbox read owns the action threads it takes"`.

---

### Task 4: An inactive session's actions claim only its own conversations, and inactive chain owners don't hold work

**Files:**
- Modify: `apps/hub/src/modules/sessions/claims.ts`, adding `claimsWhenInactive`
- Modify: `apps/hub/src/modules/sessions/sessions.service.ts`: `recordClaims`, at most 4 lines. The
  file is at 285/300 lines.
- Modify: `apps/hub/src/modules/sessions/routing.ts`: `chainOwner`
- Create: `apps/hub/src/modules/sessions/inactive-claims.test.ts`
- Test: `apps/hub/src/modules/sessions/claims.test.ts`
- Test: `apps/hub/src/modules/sessions/routing.test.ts`

**Interfaces:**
- **Produces:**
  - `claimsWhenInactive(method: RpcMethodName): boolean`, true exactly for `'message.send'` and
    `'escalate'`.
  - `recordClaims` returns early when the calling session's row has `active !== 1` and
    `!claimsWhenInactive(method)`.
  - `chainOwner` skips a parent owner or task owner whose session is listed but `active === false`.
    Thread owners (any state) and away or pull chain owners still hold, as before.

- [ ] **Step 1: Write the failing tests**
  - `claims.test.ts`:
    - `it('lets an inactive session claim only conversations it sends in')`: true for
      `message.send` and `escalate`; false for `task.create`, `task.act`, `review.request`,
      `review.submit`, `plan.start`, `plan.contribute`, `plan.submit`, `plan.cancel` and
      `inbox.get`.
  - `routing.test.ts`:
    - `it('an inactive parent owner does not hold the work')`:
      `input({ sessions: [s({ id: 's1', active: false }), s2], parentOwner: 's1' })` equals
      `{ kind: 'deliver', sessionId: 's2', claim: true, reason: 'longest-active session' }`.
    - `it('an inactive task owner does not hold the work')`: the same with `taskOwner`.
    - `it('an away parent owner still holds')`: the result is `held for s1 (away)`.
    - Keep `'holds for an inactive owner'`, the thread owner case.
  - `inactive-claims.test.ts`, using `createBobDispatchHarness`, a real thread, and an opened but
    not activated session `s`:
    - `it('a private session owns the conversation it asks in')`:
      `sessions.recordClaims(callAs(s), 'message.send', {}, { threadId })` gives
      `ownerOf(thread) === s`.
    - `it('a private session does not own a task it creates')`: with `'task.create'`, the owner is
      `null`.
    - `it('an active session still owns the task it creates')`.
    - `it("a child thread of a private session's conversation goes to an active session")`:
      1. A thread whose `parentThreadId` is owned by inactive `s`.
      2. An active push `s2` exists.
      3. Expect `sessions.route('bob-agent', ask(child))` to match `{ kind: 'deliver', sessionId: s2 }`.
      4. Expect `sessions.effectiveOwner(child, 'bob-agent')` to be `null`.

- [ ] **Step 2: Run the tests to make sure they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `chainOwner` keeps its owners list. For entries with `claim: true`, it continues past a found
    session when `!session.active`.
  - `recordClaims` reads `this.repo.get(sessionId)?.active`.
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS. Also run the integration tests
  (`tests/integration/sessions.e2e.test.ts`, "the answer comes back to the session that asked")
  with nats-server, as described in the Global Constraints. Expected: they PASS, and are not skipped.
- [ ] **Step 5: Commit** `"Hub: private sessions own only their conversations; inactive chain owners don't hold work"`.

---

### Task 5: The plugin's inbox shows what is waiting, and the release

**Files:**
- Modify: `plugins/agentmesh/src/tools/messaging.ts` (the `inbox` tool, about lines 126-150)
- Test: `plugins/agentmesh/src/tools/tools.test.ts` (next to the `inbox names the unread threads…`
  case)
- Modify: `packages/common/src/version.ts`, the 9 workspace `package.json` files and
  `plugins/agentmesh/.claude-plugin/plugin.json`: `0.4.3` becomes `0.4.4`
- Modify: the `plugins/agentmesh/dist/*` rebuild

**Interfaces:**
- **Consumes:** `inbox.get`'s `waiting` and `paused` (Task 1 and Task 2).

- [ ] **Step 1: Write the failing tests** (`tools.test.ts`)
  - `it('inbox says how many team threads wait for an active session')`. With `waiting: 2` and no
    threads, the text is exactly:
    `'(2 team thread(s) are waiting for an active session. This session is not activated, so it cannot take them.)'`
  - `it('inbox says when the mesh is paused')`. With `paused: true` and one thread, the text ends
    with `'(The mesh is paused: nothing was marked read.)'`.
  - `'Inbox zero — nothing unread.'` appears only when there are no threads, no other sessions and
    `waiting === 0`.
- [ ] **Step 2: Run** `pnpm vitest run plugins/agentmesh/src/tools`. Expected: FAIL.
- [ ] **Step 3: Implement** the two lines, plus the empty check.
- [ ] **Step 4: Bump the version and rebuild.**
  1. Set `0.4.4` in all 11 files.
  2. Run `pnpm --filter @agentmesh/plugin build`, then `pnpm check`.
  3. Expected: PASS, including `version.test.ts`.
  4. Check that `git status` shows the rebuilt `plugins/agentmesh/dist/` files.
- [ ] **Step 5: Commit** `"Plugin 0.4.4: inbox shows waiting team work and pause"`.

---

### Task 6: Docs, ADR 0009 and the threat note

**Files:**
- Create: `docs/adr/0009-mesh-window.md` (format of `docs/adr/0008-pull-mode.md`)
- Modify: `docs/adr/0006-per-session-delivery.md`. Its "Reads … claim nothing" passage gets the
  line "Amended by ADR 0009: an active session's `inbox` read claims the action threads it
  returns."
- Modify: `docs/adr/0008-pull-mode.md`. The "never delivered to, so cannot hide work" reasoning
  gets a pointer to ADR 0009, and the rule that a pull session takes unowned work only while no push
  session is ready.
- Modify: `docs/security.md`:
  - replace the false "A pull session is never delivered to, so it cannot swallow work" (about
    lines 238-245);
  - add bullets for the read rule, pause and inactive claims (spec §8 "Reads");
  - widen the auto-mode advice (about lines 748-753) to any session that has used the mesh.
- Modify: `docs/protocol.md`:
  - the read semantics (about lines 73-76 and 198-212);
  - routing rule 1 for chain owners (about lines 238-248);
  - `waiting` and `paused`.
- Modify: the `CLAUDE.md` Status section ("ADRs 0001–0009") and the plugin bullet. The version bump
  now touches `version.ts` plus 10 manifests, not `src/server.ts`.
- Modify: the design doc's status line, which becomes "Plan 1 built (reads and ownership)".

- [ ] **Step 1: Write ADR 0009.**
  - **Status:** Accepted; part 1 of 3 built.
  - **Context:** spec §1.
  - **Decision:** spec §4 plus the claim guard and the chain fall-through. Say that the relay and
    the mesh window follow in plans 2 and 3.
  - **Consequences:**
    - inactive sessions only count team work;
    - pull sessions take it only while no push session is ready;
    - Desktop users without a push session keep pull mode;
    - `thread` no longer marks unowned threads read.
- [ ] **Step 2: Make the other doc edits** listed above. Keep the style of `docs/` (plain sentences,
  bullet lists).
- [ ] **Step 3: Verify.**
  1. Run `pnpm check`. Expected: PASS.
  2. Run the integration tests with nats-server, as described in the Global Constraints. Expected:
     every file runs and passes, with none skipped.
  3. Report the counts.
- [ ] **Step 4: Commit** `"Docs: ADR 0009, read rule and threat note for plan 1"`.
