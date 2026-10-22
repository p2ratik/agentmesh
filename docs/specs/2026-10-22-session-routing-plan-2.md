# Session routing: implementation plan 2 of 3 (what interrupts an agent)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:**

- Only deliveries that change what an agent should do now interrupt it.
- Status updates ride along on things that happen anyway, and they are never lost.

**Architecture:**

- Every delivery is labelled `action` or `status` by the code that creates it, per recipient. The
  label is stored with the message (`messages.status_for`) and with the outbox row
  (`deliveries.class`).
- The plugin pushes action items. It holds status items in an FYI buffer and shows them:
  - at the end of the next mesh tool result;
  - in the footer of the next action push.
- Once shown, the plugin reports them through a new `messages.seen` RPC, and only then do they
  count as read.
- Echoes are dropped where they are made:
  - the task `Operation` knows the root caller (`rootActorId`);
  - consequences the caller must still learn become a note on its own tool result.
- The outbox picks pending rows per (recipient, thread), so held threads can't starve the others.

**Tech stack:** Node 24 (`node:sqlite`), TypeScript 7, zod 4, nats.js v3, vitest 5, MCP SDK
1.32.1, tsup, pnpm 10.

**Spec:** `docs/specs/2026-10-21-session-routing-design.md`. Read §4 (Part B), §7 and §9. Plan 1
(`docs/specs/2026-10-21-session-routing-plan.md`) is built and merged; this plan builds on its
interfaces:

- `SessionDispatcher` (`apps/hub/src/modules/sessions/dispatcher.ts`) and `DeliveryReceipt` /
  `DeliveryPort` (`apps/hub/src/ports.ts`);
- the outbox (`apps/hub/src/core/outbox.ts`) and `PostInput` (`apps/hub/src/contracts.ts`);
- the plugin's `runSessionInbox` (`plugins/agentmesh/src/inbox/session-inbox.ts`), per-call notes
  in `callTool` (`plugins/agentmesh/src/tools/registry.ts`), and the RPC response `notes`.

**Rulings carried into this plan:**

- **P2-R1.** The spec's third ride-along path (a `UserPromptSubmit` hook that adds status items to
  the human's next prompt) moves to plan 3. It needs the same hook and window-pairing work as the
  summary card. Plan 2 covers the tool-result and action-push paths; the inbox's FYI section is the
  backstop.
- **P2-R2.** Echoes: a participant never gets a delivery that only reports its own call, including
  hub steps that call triggered. New work for that participant is not an echo and is still
  delivered, for example "round 2 opened, contribute". Where the caller must learn a consequence,
  it becomes a one-line note on the caller's own tool result instead of a delivery ("no reviewer
  found").
- **P2-R3.** The hub's minimum plugin version becomes `0.3.0`. Status items count as read only once
  shown (`messages.seen`), which 0.2.0 plugins can't report. The plugin version becomes `0.3.0`.
- **P2-R4.** This plan also fixes the follow-ups the plan-1 final review parked (Task 8): activation
  in a session's first seconds, the "could not reach" wording, a sessionless call after a failed
  hello, read filters that ignore the parent and task owner, and the split table in
  `docs/configuration.md`. The noisy starvation warning disappears with Task 6.

## Global constraints

- Work in `G:\Projects\AgentMesh-interrupts`, on branch `agent/pratik/interrupts` (based on
  `origin/agents` a4f8cf4). Never edit other agents' branches. Never push or open a PR until Pratik
  says so.
- No source file over 300 lines; `pnpm check:size` enforces it. Classification helpers and the FYI
  formatting stay pure, with no I/O.
- Every wire shape is a zod schema in `packages/protocol`. Each config option is in
  `packages/config` with a default, validation, a commented example in `config/examples/` and an
  entry in `docs/configuration.md`.
- `@modelcontextprotocol/sdk` stays pinned at `1.32.1`. tsup keeps `removeNodeProtocol: false` and
  the `createRequire` banner.
- Plugin version `0.3.0` goes in `plugins/agentmesh/.claude-plugin/plugin.json`,
  `plugins/agentmesh/package.json` and `plugins/agentmesh/src/server.ts` (`VERSION`). Rebuild and
  commit `plugins/agentmesh/dist/server.js`. The hub's minimum client version becomes `0.3.0`.
- Modules talk through their services and the outbox, never through each other's tables. Messaging
  owns `messages.status_for`; the outbox owns `deliveries`.
- Secrets never go into logs or tool output. FYI lines are built from message bodies the hub has
  already redacted; don't re-render raw text.
- Windows dev box:
  - write files with the Write and Edit tools, not bash heredocs;
  - `python3` is a stub, so use node;
  - never kill processes you did not start (another agent runs a nats-server).
- Run `pnpm check` before every commit that touches TypeScript, and keep it green (baseline: 412
  passed, 24 skipped).
- Commit messages end with the `Co-Authored-By` line your harness gives you.

## Review focus

1. **A status item is never lost silently.** If it was delivered but not yet shown, or the plugin
   died with it still buffered, it stays unread and shows in the inbox's FYI section.
   Tasks 5 and 7.
2. **An action is never downgraded by mistake.** Questions, review requests, a verdict on your own
   task and new rounds always push. Table-driven tests in Tasks 3 and 4.
3. **The echo filter never hides new work.** The contributor whose contribution opened round 2
   still gets the round-2 prompt. A caller whose submit found no reviewer sees that as a note.
   Tasks 3 and 4.
4. **A mixed batch in one thread** (status first, then action): the thread is still claimed by the
   action's session, and the read cursor never passes an unshown status that a later push didn't
   show. Tasks 5 and 7.
5. **Bursts stay quiet.** A plan turning into many tasks interrupts each assignee once per task they
   own, not once per notice; everything else is FYI. Task 9.

---

### Task 1: Protocol: delivery classes, `messages.seen`, FYI in the inbox, rule class

**Files:**

- Modify:
  - `packages/protocol/src/messages.ts` (`DeliveryClass`)
  - `packages/protocol/src/sessions.ts` (`SessionDelivery`, `SessionInbound`)
  - `packages/protocol/src/rpc/messaging.ts` (`messages.seen`; `inbox.get` thread entry gains `fyi`)
  - `packages/config/src/schema/rules.ts` (`notify.class`)
  - `config/examples/rules/*.yaml` (one commented `class: status` example)
  - `docs/configuration.md` (rule `class` row)
- Test: `packages/protocol/src/sessions.test.ts` and the config package's rules tests.

**Interfaces (produces):**

- `DeliveryClass = z.enum(['action', 'status'])`.
- `SessionDelivery = MeshMessage.extend({ class: DeliveryClass.default('action') })`.
- `SessionInbound`'s `deliver` variant becomes
  `messages: z.array(SessionDelivery).min(1).max(MAX_DELIVERY_MESSAGES)`.
- `'messages.seen'`:
  - callers `['agent']`;
  - params `{ messageIds: z.array(z.string()).min(1).max(500) }`;
  - result `{ ok: z.literal(true) }`.
- The `inbox.get` result thread entry gains `fyi: z.boolean().default(false)`: true when every
  unread message in the thread is status for the caller.
- The `notify` rule action gains `class: DeliveryClass.default('action')`.

- [ ] **Step 1: Write the failing tests.**
  - `a deliver batch keeps each message's class and defaults to action`.
  - `messages.seen needs at least one id and at most 500`.
  - `a notify rule defaults to class action and accepts status`.
- [ ] **Step 2:** Run `pnpm vitest run packages/protocol packages/config`. Expect FAIL.
- [ ] **Step 3:** Implement. Keep `pnpm check` green: the hub doesn't use the new fields yet.
- [ ] **Step 4:** Run `pnpm check`. Expect it green.
- [ ] **Step 5:** Commit `Protocol: delivery classes, messages.seen, FYI inbox flag, rule class`.

### Task 2: Hub: store the class per recipient and carry it to the dispatcher

**Files:**

- Create: `apps/hub/src/db/migrations/005-delivery-class.ts`.
- Modify:
  - `apps/hub/src/db/migrate.ts`
  - `apps/hub/src/contracts.ts` (`PostInput.deliveryClass`; `Outbox.enqueueDelivery`)
  - `apps/hub/src/modules/messaging/post.ts`
  - `apps/hub/src/modules/messaging/messages.repo.ts`
  - `apps/hub/src/core/outbox.ts` (store `class` and `thread_key`; payload carries `class`)
  - `apps/hub/src/ports.ts` (`DeliveryPort` messages are `SessionDelivery`; `MemoryPorts`)
  - `apps/hub/src/modules/messaging/send.handlers.ts`
- Test: `apps/hub/src/modules/messaging/messaging.test.ts`, `apps/hub/src/core/outbox.test.ts`.

**Migration 005:**

```sql
ALTER TABLE messages ADD COLUMN status_for TEXT NOT NULL DEFAULT '[]';
ALTER TABLE deliveries ADD COLUMN class TEXT NOT NULL DEFAULT 'action'
  CHECK (class IN ('action', 'status'));
ALTER TABLE deliveries ADD COLUMN thread_key TEXT;
UPDATE deliveries SET thread_key = json_extract(payload, '$.threadId');
CREATE INDEX deliveries_pending_by_thread ON deliveries(state, recipient_id, thread_key);
```

**Interfaces (produces):**

- `PostInput.deliveryClass?: DeliveryClass | ((recipientId: string) => DeliveryClass)`, defaulting
  to `'action'`.
- `post()` stores `status_for`, a JSON array of the recipients for whom the message is status. It
  calls `outbox.enqueueDelivery(message, recipientId, held, cls)`.
- `Outbox.enqueueDelivery(message: MeshMessage, recipientId: string, held: boolean, cls?:
  DeliveryClass): void`. The payload is `{ ...message, class: cls ?? 'action' }`.
- `DeliveryPort.deliver(recipientId: string, messages: SessionDelivery[]): Promise<DeliveryReceipt>`.
- `MessagingService.classFor(messageId: string, participantId: string): DeliveryClass` reads
  `status_for`.
- Teammate posts in `send.handlers.ts`:
  - a `reply` with status `working` or `info` is `status`;
  - anything else (ask, broadcast, other replies, escalate) is `action`.
  - Extract the `message.send` body into small helpers so Biome's complexity warning on that
    handler goes away.

- [ ] **Step 1: Write the failing tests:**
  - `a working or info reply is status for its recipients; an ask is action`: check `classFor`, and
    that `ports.deliveries` payloads carry `class`.
  - `a per-recipient class function stores status only for the recipients it names`.
  - `migration 005 backfills thread_key from the payload`, starting from a v4 database with one
    pending row.
- [ ] **Step 2:** Run `pnpm vitest run apps/hub/src/modules/messaging apps/hub/src/core apps/hub/src/db`.
  Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm check`. Expect it green, with the `send.handlers.ts` complexity warning
  gone.
- [ ] **Step 5:** Commit `Hub: store each delivery's class and carry it to the dispatcher`.

### Task 3: Hub: task notices get their class, and echoes are dropped

**Files:**

- Create:
  - `apps/hub/src/modules/tasks/effects/classes.ts`: pure helpers.
  - `apps/hub/src/modules/tasks/effects/classes.test.ts`.
- Modify:
  - `apps/hub/src/modules/tasks/operation.ts`: echo filter and caller notes.
  - `tasks/transitions.ts`: the summary.
  - `tasks/tasks.service.ts`: review submitted, and copying op notes into `call.notes`.
  - `tasks/handlers.ts`.
  - `tasks/effects/notify.ts`, `assign.ts`, `reviews.ts` and `lifecycle.ts`.

**Classification:** every task-side site from the inventory.

| Site | Recipient | Class | Echo handling |
| --- | --- | --- | --- |
| transition summary (`transitions.ts` `#summary`) | other participants | status, except the previous assignee of an `assign`, `handoff` or `claim` that moved the task away from them: action (a reason to stop) | also drop `rootActorId` |
| review submitted (`tasks.service.ts`) | the task's assignee | action | sender already excluded |
| review submitted | everyone else | status | |
| `notifyAssignee`: assigned, changes requested, approved, cancelled | assignee | action | drop if assignee is `rootActorId`. A self-`claim` is dropped too: the RPC result already shows the task |
| `notifyCreator`: blocked | creator | action | drop if creator is `rootActorId` |
| `notifyCreator`: done | creator | status | drop if creator is `rootActorId` |
| `autoAssign` board offer | audience | status | drop `rootActorId` |
| `no_reviewer` | assignee and creator | action | for `rootActorId`, becomes a caller note: "No reviewer was found for task-N; request one with request_review." |
| review requested | reviewer | action | |
| `releaseDependents` | dependent's assignee | action | drop if `rootActorId` |

**Interfaces:**

- `Operation`:
  - gains `notes: string[]` and
    `post(input: PostInput | (() => PostInput), opts?: { noteForCaller?: string })`.
  - At `flush`, every post drops `rootActorId` from its recipients when `rootActorId` is an agent.
  - When it is dropped and `noteForCaller` was given, the note is appended to `op.notes`.
- The task RPC handlers append `op.notes` to `call.notes` after the operation commits. They return
  them through the existing response-notes path.
- `classes.ts` holds the table's rules as pure functions:
  - `assigneeNoticeClass(action)`;
  - `creatorNoticeClass(state)`;
  - `reviewSubmittedClass(recipientId, task)`.

- [ ] **Step 1: Write the failing tests:**
  - in `classes.test.ts`, a table-driven case for each row above;
  - `tasks.lifecycle.test.ts`: `a reviewer is not echoed the approval its review triggered`, where
    `submitReview` → hub approve sends the reviewer nothing;
  - `a creator assigning the task to itself gets no brief`;
  - `an agent whose submit finds no reviewer gets a note, not a delivery`, so the RPC response
    carries the note;
  - `the assignee's verdict notice is action and the creator's copy is status`;
  - `a task handed off away from an agent tells that agent as action`.
- [ ] **Step 2:** Run `pnpm vitest run apps/hub/src/modules/tasks`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm check`. Expect it green. Existing task tests that expected echoes are
  updated to the new rule, and each change is listed in the report.
- [ ] **Step 5:** Commit `Hub: task notices are action or status; no echoes`.

### Task 4: Hub: planning and ingest classes

**Files:**

- Modify:
  - `apps/hub/src/modules/planning/planning.service.ts`
  - `apps/hub/src/modules/planning/flow.ts`
  - `apps/hub/src/modules/ingest/rules/actions.ts`
- Test: `planning.flow.test.ts`, `ingest.rules.test.ts`.

**Classification:**

| Site | Class | Echo |
| --- | --- | --- |
| plan started (invite) | action | drop the initiating agent; its RPC result shows the plan |
| plan awaiting approval | action | caller already skipped |
| plan cancelled | action | caller already skipped |
| next round opened (`advance`) | action | keep the contributor who triggered it: it's new work |
| tasks created (`materialize`) | status | drop the caller |
| synthesis prompt | action | |
| synthesis handed to a new facilitator | action | |
| hand-off notice to the old facilitator | action | a reason to stop |
| "synthesizing" notice to the others | status | |
| plan stalled, to a human | no change | humans get no agent delivery |
| ingest `notify` | the rule's `class` | |
| ingest `create_task` | goes through Task 3's rules | |

The class of an external event comes only from the team's rule config, never from the event's
content.

- [ ] **Step 1: Write the failing tests:**
  - `a round prompt reaches every participant as action, including the one whose contribution
    opened it`;
  - `materialized tasks notify participants as status`;
  - `a notify rule with class status delivers status; the default is action`;
  - `an event's own fields cannot change its class`: an event payload carrying `class: 'status'`
    under a rule without `class` is still action.
- [ ] **Step 2:** Run `pnpm vitest run apps/hub/src/modules/planning apps/hub/src/modules/ingest`.
  Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm check`. Expect it green.
- [ ] **Step 5:** Commit `Hub: planning and ingest notices get their class`.

### Task 5: Hub: dispatch status without claiming, `messages.seen`, FYI inbox

**Files:**

- Modify:
  - `apps/hub/src/modules/sessions/dispatcher.ts`
  - `apps/hub/src/modules/messaging/messaging.service.ts` (`markSeen`)
  - `apps/hub/src/modules/messaging/inbox.ts` (`fyi`)
  - `apps/hub/src/modules/messaging/thread.handlers.ts` (the `messages.seen` handler)
  - `apps/hub/src/contracts.ts`
- Test: `apps/hub/src/modules/sessions/dispatcher.test.ts`, `messaging.test.ts`.

**Behaviour:**

- Status deliveries route exactly like action ones (owner, then the fallback rules), so unowned
  status rides along in the session the fallback picks.
- A status delivery never claims a thread. A thread is claimed in a batch when its first route has
  `claim` and at least one of its delivered messages in that batch is action.
- In `commit`, only the action ids are passed to `markRead`. Status ids are published but stay
  unread.
- `MessagingService.markSeen(agentId: string, messageIds: string[]): void`:
  - marks read only the ids whose message lists `agentId` as a recipient (from the messages table);
  - silently ignores the others;
  - advances each thread's cursor to the highest seq given for it.
- The `messages.seen` handler calls `markSeen(call.actor.id, …)`.
- `readInbox` sets `fyi` on a thread when every unread message in it is status for the caller.
  Threads that need the caller come first, then FYI threads, each group ordered as today.

- [ ] **Step 1: Write the failing tests:**
  - `a status delivery is published but stays unread until seen`;
  - `messages.seen marks only the caller's own deliveries read`, so another agent's id is ignored;
  - `a status message never claims its thread; a later action in the same batch does`;
  - `the inbox lists threads needing action before FYI threads and flags FYI ones`;
  - `a status item delivered to a session that then dies stays in the inbox's FYI section`.
- [ ] **Step 2:** Run `pnpm vitest run apps/hub/src/modules/sessions apps/hub/src/modules/messaging`.
  Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm check`. Expect it green.
- [ ] **Step 5:** Commit `Hub: status rides along unread until seen; FYI inbox`.

### Task 6: Hub: the outbox picks pending rows per thread

**Files:**

- Modify: `apps/hub/src/core/outbox.ts`.
- Test: `apps/hub/src/core/outbox.test.ts`.

**Behaviour:**

- `PENDING_DELIVERIES` partitions by `(recipient_id, thread_key)` and takes at most
  `THREAD_WINDOW = 50` of each pair's oldest rows, ordered by `created_at, rowid`.
- A flush loops again only when some pair's full window delivered something.
- The per-recipient starvation warning and its rate limiter are removed: a held thread can no
  longer hold back other threads. A thread whose full window waits logs at `debug`.

- [ ] **Step 1: Write the failing tests:**
  - `250 rows waiting on one held thread don't hold back a deliverable message in another thread`:
    the deliverable row is published in the first flush;
  - `a thread with more than 50 deliverable rows drains over successive loops in order`.
- [ ] **Step 2:** Run `pnpm vitest run apps/hub/src/core`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm check`. Expect it green.
- [ ] **Step 5:** Commit `Hub: pick pending deliveries per thread`.

### Task 7: Plugin: the FYI buffer, ride-along, `seen`, split inbox; release 0.3.0

**Files:**

- Create:
  - `plugins/agentmesh/src/inbox/fyi.ts`: `FyiBuffer` plus pure formatting.
  - `plugins/agentmesh/src/inbox/fyi.test.ts`.
- Modify:
  - `plugins/agentmesh/src/inbox/session-inbox.ts`
  - `plugins/agentmesh/src/inbox/render.ts`: the action event gets an FYI footer.
  - `plugins/agentmesh/src/tools/registry.ts`: append FYIs to each tool result.
  - `plugins/agentmesh/src/tools/messaging.ts`: `inbox` sections.
  - `plugins/agentmesh/src/main.ts` / `session.ts`: wiring.
  - Version `0.3.0` in the three places, and the hub's minimum version in
    `apps/hub/src/modules/sessions/handlers.ts`.
  - `plugins/agentmesh/dist/server.js`: rebuilt.

**Interfaces:**

- `FyiBuffer`:
  - `add(messages: SessionDelivery[]): void` keeps at most 50, oldest dropped first, and counts the
    drops.
  - `take(): { lines: string[]; ids: string[]; dropped: number }` empties the buffer.
- `formatFyi(taken): string` (pure) returns, exactly:
  `FYI (<n>):` followed by one line per item, `· <thr> «<subject, max 60 chars>» <first line of
  body, max 100 chars>`. When `dropped > 0` it adds a final line, `· …and <dropped> more: call
  inbox`. It returns the empty string when there is nothing.
- `runSessionInbox`, per `deliver` batch:
  1. Add the status items to the buffer, skipping ids already in `RecentIds`, and count them as
     delivered for the ack.
  2. Push the action items one thread per event (as today). Before the first action push, take the
     buffer and append `formatFyi` as a footer to that event.
  3. Ack everything delivered.
  4. Report the shown FYI ids with `messages.seen`, fire-and-forget; log a warn on failure. Ids not
     reported stay unread and appear in `inbox`.
- `callTool` appends the buffer's `formatFyi` as a trailing text block to every result after the
  call's notes, and reports those ids through `messages.seen` the same way. It doesn't append to a
  `messages.seen` call, so it can't recurse.
- `inbox` prints `Needs you:` and then the threads that need action, then `FYI:` and one line per
  FYI thread (header plus the first line of its last message). Each section appears only when it
  has something.
- The instructions text explains it in one line: "Status updates ride along at the end of your
  next mesh tool result; they never start a turn." Keep the 4096-character test green.

- [ ] **Step 1: Write the failing tests:**
  - in `fyi.test.ts`: the cap and drop count, the exact format, and empty → `''`;
  - in `session-inbox.test.ts`:
    - `status items are acked without a channel event`;
    - `the next action push carries the buffered FYIs and reports them seen`;
    - `a redelivered status id is acked without buffering it twice`;
  - in `tools.test.ts`:
    - `tool results end with buffered FYIs, which are then reported seen`;
    - `inbox shows Needs you before FYI`;
  - in `instructions.test.ts`: the new line, still under 4096.
- [ ] **Step 2:** Run `pnpm vitest run plugins/agentmesh`. Expect FAIL.
- [ ] **Step 3:** Implement. Bump to `0.3.0` and the hub minimum to `0.3.0`, then run
  `pnpm --filter agentmesh build`.
- [ ] **Step 4:** Run `pnpm check`. Expect it green. The dist is rebuilt.
- [ ] **Step 5:** Commit `Plugin 0.3.0: status rides along (FYI), split inbox`.

### Task 8: Plan-1 follow-ups (P2-R4)

**Files:**

- Modify:
  - `plugins/agentmesh/src/tools/sessions.ts` and `session.ts`, plus the `ToolDeps` wiring
  - `plugins/agentmesh/src/hub.ts`
  - `apps/hub/src/modules/sessions/handlers.ts`: the `session.check` failure copy
  - `apps/hub/src/modules/messaging/inbox.ts` and `thread.handlers.ts`, plus a sessions-side helper
  - `docs/configuration.md`
- Test: the matching plugin and hub tests.

**Changes:**

1. **Activation timing.** `activate` with no code first waits until this session's inbox is
   listening: a promise resolved by `onListening`, bounded at 3 s. Only then does it call
   `session.check`.
2. **"Could not reach" copy.** The `session.check` failure message names the real causes: "the
   session started seconds ago (try again in a few seconds)", or "NATS permissions predate plugin
   0.2.0 (static mode: re-render nats.conf and reload NATS; auth-callout mode: restart Claude
   Code)".
3. **Sessionless calls.** When `HubClient.call` finds no session and no hello in flight, it starts
   `sayHello` itself and waits up to 5 s, as it does for an in-flight hello, before calling without
   a session.
4. **Read filters use the routing owner chain.** `thread.get` and `inbox` decide "owned by another
   session" with the same chain routing uses: the thread's owner, then its parent's, then its
   task's.
   - Add `SessionsService.effectiveOwner(threadId: number, agentId: string)`, returning the same
     shape as `ownerOf`, built on the routing inputs.
   - Messaging reads it through its late-bound owner reader.
5. **The split table.** Move the `deliveryRetentionDays` paragraph in `docs/configuration.md` below
   the limits table so the table renders as one.

- [ ] **Step 1: Write the failing tests:**
  - `activate waits for the session to listen before asking for a check`;
  - `a call with no session says hello first`;
  - `the inbox treats a thread whose parent another session owns as that session's`;
  - the check-failure copy test.
- [ ] **Step 2:** Run the focused tests. Expect FAIL.
- [ ] **Step 3:** Implement and rebuild dist.
- [ ] **Step 4:** Run `pnpm check`. Expect it green.
- [ ] **Step 5:** Commit `Fix plan-1 follow-ups: activation timing, check copy, hello on demand,
  owner chain, docs table`.

### Task 9: End to end over NATS

**Files:**

- Create: `tests/integration/interrupts.e2e.test.ts`.
- Modify: `tests/integration/support.ts` only if a helper is needed.

**Setup:** start your own nats-server (`-js`) on a free port with a new data directory, and set
`AGENTMESH_TEST_NATS` and `AGENTMESH_TEST_NATS_BIN`. The binary is in the session scratchpad
(`…\scratchpad\nats-bin-rebase\nats-server-v2.15.1-windows-amd64\nats-server.exe`); extract
`…\scratchpad\nats\nats.zip` if it's missing. Stop only what you start.

- [ ] **Step 1: Write the tests:**
  - `a working reply interrupts nobody and rides along on the next tool result`. Bob replies with
    status `working`; Alice gets no channel event within 3 s. Her next `peers` call ends with
    `FYI (1):` and the reply's line. A later `inbox` doesn't list it again.
  - `a question still interrupts`.
  - `the reviewer gets no echo of its own approval`: after `review_submit approve`, the reviewer
    gets no channel event within 3 s, and the assignee gets the verdict.
  - `a plan's tasks interrupt each assignee once per task`.
- [ ] **Step 2:** Run `pnpm build`, then `pnpm test:integration` with your server. Expect the new
  tests to pass and the existing 24 to stay green.
- [ ] **Step 3:** Fix anything the run exposes at the root, with a unit test that fails without the
  fix.
- [ ] **Step 4:** Run `pnpm check` and `pnpm test:integration`. Expect both green.
- [ ] **Step 5:** Commit `E2E: status rides along, questions interrupt, no echoes`.

### Task 10: Docs

**Files:**

- Modify:
  - `docs/protocol.md`: delivery classes; `SessionDelivery`; `messages.seen`; the inbox's `fyi`;
    the echo rule and caller notes; the per-thread outbox window.
  - `docs/security.md`: an external event's class comes from rule config, not content;
    `messages.seen` only marks the caller's own deliveries.
  - `docs/events-and-hermes.md` and `docs/configuration.md`: rule `class`.
  - `docs/adr/0006-per-session-delivery.md`: a short "Plan 2" note on classes and the per-thread
    window.
  - `plugins/agentmesh/README.md`: FYI behaviour and inbox sections.
  - `docs/deploy.md`: upgrading to 0.3.0 (hub minimum; restart sessions).
  - `CLAUDE.md`: the channel-push bullet.
  - The design doc's status line: "Part B built (plan 2)".

- [ ] **Step 1:** Write the docs, verifying each claim against the code.
- [ ] **Step 2:** Run `pnpm check`. Expect it green. Check that every new relative link resolves.
- [ ] **Step 3:** Commit `Docs: delivery classes, FYI ride-along, messages.seen, rule class`.
