# Sessions, interruptions and context — design

Date: 2026-10-21 · Status: Part A built (plan 1; see
[ADR 0006](../adr/0006-per-session-delivery.md)); Part B built (plan 2). The `UserPromptSubmit`
ride-along path moved to plan 3 (P2-R1). Agreed with Pratik in conversation. It passed an independent builder
check; that check's four questions are answered in §3 and §4, marked "my call". The implementation
plan comes next. Reviews, merging, policy delivery and the rest of the skill are designed later
(§10).

## 1. Why

This design comes from a two-day test run (2026-10-18 to 2026-10-20). Two agents, `pratik-agent`
and `pratik-test-agent`, ran on one laptop and built the invite-only onboarding plan together. The
mesh carried their conversation well. Three things went wrong.

**Messages were lost to the wrong session.**

- A person runs many Claude Code sessions at once: some on the team's work, some on a personal job.
  Each session starts its own copy of the plugin, and every copy connects as the same agent.
- All copies pull from that agent's single durable inbox consumer, so each message lands in
  whichever session pulls first.
- A session started without the channel flag still takes messages. Claude Code drops them silently
  (`Channel notifications skipped: … not in --channels list`). Its plugin has already acked the
  message, so it is gone from the queue.
- On 2026-10-20, two Opzami-repo sessions and an analysis session were connected as `pratik-agent`,
  all without the flag.
  - The test agent sent 9 messages after 13:11 UTC; 5 never reached the working session. Among them
    were the task-19 approval and the task-17 round-3 "done".
  - Pratik noticed only because the agent went quiet.
  - On 2026-10-18 the test agent lost 4 messages the same way.
- Even a message that lands may land in a session that knows nothing about the work. The review
  result for task-17 can reach session B while session A is doing task-17.

**Every message interrupted, whatever it was.**

- Every hub message is pushed into the session, and in an idle session each push starts a Claude
  turn.
- 59 of the test agent's 106 pushes started a turn. 37 of `pratik-agent`'s 101 pushes were task
  status notices, and 10 of those were echoes of its own verdicts.
- 12 pushes arrived in one second when a plan became tasks.
- A push never marks a message read, so `inbox` repeats it. 31 of the test agent's 35 inbox
  messages had already been pushed. Replying marks every earlier message in the thread read,
  including ones the agent never saw (`post.ts:78`).
- In the test agent's words: "Nothing separates 'needs action' from 'for your information.'"

**Context was lost after `/clear`, and task talk was scattered.**

- Both agents rebuilt their state from `git log`, `git worktree list`, the PR diff and GitHub
  comments.
- `task_get` shows only the first 160 characters of each review, and a review round done by plain
  reply is not recorded at all.
- Task instructions landed outside the task's thread:
  - "Merge status" (thr-17) carried tasks 6–18 for two days.
  - 24 of `pratik-agent`'s 44 replies went to side threads.
  - "Rebase #19 and check the lookbehinds" for task-17 went to thr-17, not task-17's thread
    (thr-24).
- The full evidence is in that session's findings (`pratik-agent-findings.md`,
  `test-agent-findings.md`).

## 2. Goals, non-goals, anti-goals

Goals:

- A message is never lost because of which session took it.
- Follow-ups reach the session that is doing the work.
- A session receives nothing unless its human turned it on. Personal sessions stay invisible.
- A session is interrupted only when something changes what it should do now. Exactly one session
  is interrupted by a brand-new request.
- After `/clear`, compaction or a handover, an agent knows its work in seconds, without git
  archaeology.

Non-goals:

- Showing a session's conversation to anyone. Only its one-line description is shared.
- A model on the hub deciding routing or importance.
- Coordinating sessions locally on one laptop. The same agent may run on two machines, so the hub
  tracks sessions.

Anti-goals (a failure even if it technically works):

- A session that cannot show pushes still takes messages.
- Sessions get interrupted by work they don't own, or by status noise.
- A status update is silently never seen.
- A routing decision can't be explained in one line.
- Anything about a session is exposed before its human activated it.
- A fresh context gets flooded: the agent receives an index and pulls details on demand.

## 3. Part A — Sessions and ownership

**Inactive by default.** Every session starts inactive. It keeps the mesh tools, so it can ask,
check tasks or read threads, but it receives no pushes and takes nothing off the queue.

**Activating.**

- `/agentmesh:activate` makes the session active. `/agentmesh:deactivate` turns it off again.
- Activation is confirmed end to end. The hub sends the session one test message, and the session
  goes live only after its Claude sees it and confirms with a tool call. Claude Code gives a plugin
  no documented way to know whether a session accepts channel pushes, so this round trip is the
  proof.
- If the test never arrives, the session stays inactive and Claude tells its human to restart with
  the channel flag.

**Description.**

- On activation, the session's Claude writes a one-line description of what the session is doing,
  for example "checkout redesign in opzami/web". The human can type their own instead.
- Claude updates the line when the session's focus changes.
- The hub adds the session's repo, branch and the tasks it owns. The description goes through secret
  redaction.

**Seeing a teammate's sessions.** `peers` lists each teammate's active sessions with those
descriptions. Inactive sessions never appear.

**Choosing a session for a new conversation.** The asking agent may pick one of the recipient's
active sessions. It is the party that knows what its question is about.

**Ownership is sticky.**

- A session owns a thread or task once it acts on it: it sends the question, replies, accepts or
  claims a task, opens or submits a PR, submits a review, or contributes to a plan.
- From then on, every message in that thread, in threads opened from it (`parent_thread_id`), or
  about a task it owns goes only to that session.

**Fallback** when nobody picked a session, or the picked one is gone. The hub picks the first match:

1. The owner of the thread, its parent thread or its task, if that session is still active.
2. An active session in the repo the message is about (from its task, or a repo the asker named).
3. The recipient's longest-active session. *(Pratik accepted this default during the playback.)*
4. None. The message waits as unread in the hub, and the next session the human activates gets it.

**Precedence: the first owner keeps the work.** Ownership moves only through `/agentmesh:take`, or
when the owning session ends. Pratik's words: messages go to the working session "until the working
session is closed".

- If another active session of the same agent acts on owned work, the action goes through. The tool
  result tells it which session owns the work, that replies will go there, and that `take` moves it.
- Ownership beats an asker's pick. The pick decides only for work nobody owns yet. *(My call: the
  owner has the context, while the pick was made from a one-line description.)*

**Inactive sessions that act.**

- An inactive session can still `ask`, reply or act on tasks. It then owns that thread or task, but
  as a held owner: nothing is pushed to it, and nothing is rerouted elsewhere.
- Answers wait for it. They show up on its next mesh tool call (§4) and in `inbox` or `thread`.
- Reads from an inactive session mark only its own held items as read, never work another session
  owns.
- When it closes, its held work is released like any other. *(My call. It keeps "inactive sessions
  keep the tools", which Pratik agreed to, without misrouting the answers.)*

**Absence: sleep, crash, resume.**

- A clean close (`session.bye`, `/agentmesh:deactivate`) releases ownership at once.
- A session that stops heartbeating without saying bye is marked away, not released. Its work is
  held for a grace period: a new config option, default 2 hours *(my call)*.
- If the same plugin process reconnects within that time, after a laptop sleep for example, it is
  active again with everything it owned.
- After the grace period the work is released and routed by the fallback rules. A session that
  reconnects later takes back whatever no other session took meanwhile.
- `claude --resume` of a conversation that was active starts the activation round trip by itself,
  without the human typing `/agentmesh:activate`. On success it takes back what it owned and nobody
  else took. *(My call: the human already opted that conversation in.)*
- The hook that knows the Claude conversation id passes it to the plugin. That is the same window
  pairing as the transcript path (§10).

**Routing rules, not a model.**

- Every decision is logged with its reason, for example `routed msg-… to s-3: owns task-17`.
- The routing function is pure: (message, sessions, ownership) → session + reason. A model could
  replace it later, if the logs show the rules misrouting.

**Closing.**

- A session releases everything it owns when it closes, deactivates or stops heartbeating.
- The next message about that work is treated as new and routed by the fallback rules. The receiving
  session gets the handover card (§6).

**`/clear`.** The plugin process survives `/clear`; the transcripts show the same process continuing
under a new session id. The session stays active and keeps what it owns. Right after the clear it
gets its card (§6).

**Moving work by hand.** `/agentmesh:take <task or thread>` moves ownership to the session where it
is typed, along with the handover card for that work.

## 4. Part B — What interrupts an agent

**Two classes.** The hub labels every delivery, at the moment it creates it, as `action` or
`status`.

- `action` means something changed what the recipient should do now:
  - a message from a teammate (agent or human), except progress replies (status `working` or
    `info`), which are `status` *(my call: progress notes shouldn't wake a reviewer)*;
  - a new step for the recipient: assigned, review requested, changes requested, approved (so merge
    and complete), or a dependency done (so start);
  - a reason to stop: the task was cancelled or reassigned away from them, or the plan closed.
- `status` is everything else: state changes that leave the recipient nothing to do, and
  other-party progress.
- The hub already computes each participant's next actions (`next-actions.ts`), so the rule is
  deterministic and testable.

Deliveries not covered by the rule above *(my calls)*:

| Delivery | Class |
| --- | --- |
| Planning round prompt, or approval requested | `action` |
| Planning synthesis or result with nothing to do | `status` |
| Board offer (`refs.action: board`): optional work to claim | `status` |
| `@all` / `@online` broadcast from a teammate | `action`, like any teammate message; the skill keeps broadcasts rare |
| `no_reviewer` notice to the task's creator | `action` |
| Ingest rule `create_task` | the normal task notices to the assignee |
| Ingest rule `notify` (external events) | set per rule in `config/rules/`: a new option, `action` or `status`, default `action` |

The class of an external event comes from the team's rule config, never from the event's content.
Untrusted webhook text cannot raise its own priority. This gets a threat note in
`docs/security.md`.

**No echoes.** A participant never receives a notice caused by its own call, including hub actions
that its call triggered. Example: the hub's "in_review → approved" right after the reviewer's own
`review_submit`.

**`action` is pushed** to the owning session as today, coalesced per thread.

**`status` is never pushed on its own.** Neither NATS nor the plugin can see whether Claude is idle,
and a push into an idle session starts a turn. So status items ride along with something that is
happening anyway, in the session that owns the work:

- appended to the next mesh tool result in that session, as one line per item;
- appended to the next `action` push;
- added to the human's next prompt in that session by a `UserPromptSubmit` hook, which costs no
  extra turn;
- listed on the card after `/clear` or compaction (§6).

Status items about work no session owns follow the same fallback as `action` items (§3). They ride
along in the session the fallback picks and never wake it. If no session is active, they wait in
the inbox. A status item is never only in the inbox while a session is active.

**Read state follows what the agent actually saw.**

- A pushed message counts as read once the plugin has handed it to Claude Code.
- A piggybacked status item counts as read once it was shown.
- Posting in a thread no longer marks earlier messages read. Senders are already excluded from their
  own unread, so the advance in `post.ts` can go.
- `thread` still marks what it returns as read.

**The inbox splits in two:** "Needs you" (`action`) and "FYI" (`status`), for this session's work
and unowned work. Other sessions' unread items show as a count only.

## 5. Part C — Keeping task talk in the task thread (skill only)

There is no hub change. Ownership routing makes this matter more, because a message goes to the
session that owns its thread. Instructions for task-17 sent in a side thread reach whoever owns that
thread.

Update `plugins/agentmesh/skills/mesh-collaboration/SKILL.md` with these rules:

- **Task talk goes in the task's own thread.** `task_get` shows the thread. Reply there instead of
  opening a new thread. If another person must be asked about the task, `ask` with
  `parent_thread_id` set to the task thread, so the answer routes back to the owning session.
- **Progress goes in the task thread as `working` replies, at milestones.** Examples: started, PR
  open, round N pushed, waiting on X. They are quiet for others (§4) and become the agent's own
  checkpoint (§6).
- **Readiness goes through workflow actions,** not reply statuses. Resubmit with `task_act`; never
  write `done` to mean "ready for re-review".
- **Don't answer FYIs.**
- **After a restart:** read the card first, pull details with `task_get` and `thread`, and search
  the previous transcript only for specifics.

The full collaboration skill is later work (§10).

## 6. Part D — Context after `/clear`: one card, three layers

The agent gets a short index and pulls details only when it needs them.

1. **The card, always loaded.** About 20 lines (my budget), with "and N more" past that.
   - One block per piece of work this session owns: task, state, branch, worktree path, PR, review
     round, the points of the last verdict, who is waiting on whom, and the owner's latest progress
     note (its last `working` reply or `task_act` note).
   - Questions this session is waiting on, and questions waiting on it.
   - Status items not yet shown (§4).
   - One line per item other sessions own, so the agent doesn't redo it.
   - At the end, the path of this window's transcript from before the `/clear`.
2. **The mesh history, on demand.**
   - `task_get` shows the full text of the current round's reviews and every round's verdict.
   - `thread` returns smaller pages by default; one read in the test was 59.6 KB.
   - Fix `task_list(assignee: "all")`, which today treats "all" as an agent's name.
3. **The previous conversation, on demand.**
   - The agent searches the earlier transcript for exact commands, errors and what its human said.
     It never reads the whole file.
   - The path is recorded by a `SessionEnd` hook (reason `clear`) and handed over at the next
     `SessionStart` in the same window.
   - The transcript never leaves the laptop, and the hub never sees it.

**The same card serves every trigger:**

- A `SessionStart` hook (startup, resume, clear, compact) loads it.
- When work changes hands (`/agentmesh:take`, or work released by a closed session), the receiving
  session gets the card for that work. It also gets the previous owner's latest note, and the
  previous transcript path when it is on the same machine.

## 7. How the parts fit

- **Ownership (A) is the one index.** It decides where a message goes, whether it interrupts (B)
  and what the card shows (D).
- **The skill (C) keeps conversations in the right thread,** so ownership stays accurate.
- **One delivery change carries A and B:** messages go only to the owning session, `action` items
  are pushed, `status` items ride along, and both count as read once seen.

## 8. Already handled, and not to reopen without new evidence

**Duplicate work from redelivery.**

- The plugin acks within milliseconds, as soon as it has handed the message to Claude Code. It does
  not ack when the work is done, so long Claude runs never hold an ack, and AckWait or in-progress
  acks don't matter.
- The plugin drops redelivered ids it already pushed.
- Publishes are deduplicated by `Nats-Msg-Id` within a 2-minute window.
- Repeated workflow actions fail with `invalid_transition`, and GitHub refuses a second PR from a
  task's fixed branch.
- In the test run, no message reached a session twice and no PR was opened twice.

**Two agents claiming or editing the same thing.**

- Claims are atomic: the hub is the single writer, and each claim is one SQLite transaction. A
  JetStream KV bucket would add a second source of truth.
- Path leases with overlap detection, plus areas in `mesh.yaml`, cover file and module ownership.
- The test run had one conflict, in `docs/security.md`.

**Rejected alternatives for Part A:**

- One "mesh session" per agent. The session doing a task would not hear its own review result.
- Notify every session and let the right one claim. That interrupts every session.
- Let the asking agent pick sessions without opt-in. It exposes personal work and goes stale.
- A hub-side model, for example Gemma or Llama, choosing the session:
  - The hub only knows repo, branch and owned tasks, so a model has little to decide on.
  - The 2 vCPU / 4 GB VM would run a 1B-class model slowly next to NATS. A hosted model is a new
    paid vendor, which policy treats as a crucial decision.
  - Its picks can't be explained or unit tested.
  - Untrusted message text, including external webhook content, would steer delivery.

## 9. Constraints

- **Security** (CLAUDE.md principle 1):
  - A session acts only for its own agent; the hub derives the agent from the NATS caller and never
    trusts a session's claim about which agent it belongs to.
  - Session ids are issued by the hub.
  - New subjects or permissions get least-privilege rules in the generated NATS config and a threat
    note in `docs/security.md`.
  - Descriptions and notes are redacted and team-visible.
  - Hooks treat their stdin as untrusted input and never print secrets.
- **Durability:**
  - The hub's database stays the source of truth.
  - A message routed to a session that dies before showing it is routed again, not dropped.
  - The transactional outbox (ADR 0004) holds end to end, so there is no dual write:
    - a state change and its deliveries commit together;
    - "delivered", "read" and "owned" commit together after the plugin's ack;
    - an action and the ownership it claims commit together.
  - Delivery is at-least-once, and the plugin drops ids it already pushed.
  - Pushes stay best-effort, and `inbox` stays authoritative.
- **Hooks:**
  - They ship in the plugin (`hooks/hooks.json`, commands under `${CLAUDE_PLUGIN_ROOT}`).
  - They must be fast, work on Windows, macOS and Linux, and never fail or block a session when the
    hub is unreachable.
  - Claude Code ignores a top-level `additionalContext`. It must be inside `hookSpecificOutput`.
- **Engineering rules:**
  - Routing and classification stay pure and unit-tested.
  - Files stay under 300 lines.
  - Contracts are zod schemas in `packages/protocol`.
  - New config options get a default, validation, an example in `config/examples` and an entry in
    `docs/configuration.md`.
  - Behaviour changes update `docs/protocol.md` and the matching docs.
  - The delivery change replaces "one durable consumer per agent" (ADR 0001), so it needs a new ADR.
  - Rebuild `plugins/agentmesh/dist/server.js` and bump the version in `plugin.json`,
    `package.json` and `src/server.ts`.
- **Other agents' work:**
  - Build on `origin/agents` (plugin 0.1.7). It already contains invite-only onboarding (hub
    `enrollment` and `callout`, plugin `join` and `session.ts`) and task-19 (departed members, in
    `post.ts`).
  - PR #19 (task-17, redaction in the bridge and hub entry points) is still open; rebase onto it
    once it merges.
  - Never edit other agents' branches.

## 10. Left to the builder, and later work

Left to the builder:

- **Delivery mechanism.** Possible shapes:
  - per-session JetStream subjects with consumers the hub manages, with `action` and `status` as
    subjects or a field;
  - hub-driven request/ack to a per-session subject, with the outbox retrying.

  Whatever is chosen must meet the durability constraint. Record the choice in the ADR.
- **Session details:** id format, heartbeat interval, how the activation test message is confirmed,
  and read-state granularity. Read-state granularity must meet the rule that an item counts as read
  only once the session owning its work has seen it.
- **Window pairing.** How a hook pairs with the plugin process of the same window, to read the card
  or the previous transcript path. Process ancestry is the likely route; verify it on Windows.
  Whether the `SessionStart` hook injects the card itself or tells Claude to call a `briefing` tool.
- **Names and limits:** tool and command names beyond `/agentmesh:activate`, `deactivate` and
  `take`; the card format; line limits.
- **Plugins without sessions.** *My call:* no compatibility mode. The hub tells pre-session plugins
  to update; the team is two agents today.

Later, designed separately:

- Reviews (GitHub versus mesh, required reviewers by label).
- Who merges and completes tasks.
- Policy delivery: it is truncated at 4096 characters, and changes reach agents slowly.
- The rest of the collaboration skill, including routine leasing.
- Accepting tasks with unfinished dependencies.
- Two agents on one laptop sharing ports and processes.
