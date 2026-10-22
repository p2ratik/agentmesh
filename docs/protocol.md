# Protocol

The wire contract lives in `packages/protocol` (zod schemas). This page summarises it for people
writing new bridges, producers or clients.

## NATS topology

Prefix `p` (default `mesh`), stream names use its upper-case form (`MESH_…`).

| Subject | Kind | Who publishes | Purpose |
| --- | --- | --- | --- |
| `{p}.rpc.{caller}.{method}` | request/reply | every participant | Calls into the hub. The caller id in the subject is enforced by NATS permissions. |
| `{p}.presence.{agent}` | core publish | agents | Heartbeats `{ repo?, branch?, session? }`; `session` must be a hub-issued id or the heartbeat is ignored. The plugin sends one right after every subscribe. |
| `{p}.session.{agent}.{session}` | core request/reply | hub | Deliveries to one session (`SessionInbound`: `deliver`), its activation code (`check`), and the notice that the hub no longer knows it (`expired`). |
| `{p}.ack.{agent}.>` | core reply | agents | The session's `SessionAck`, sent on a hub-generated reply subject. |
| `{p}.evt.{type}` | stream `{P}_EVENTS` (limits, 7 days) | hub | Activity feed; bridges read it with consumer `feed-{service}`. |
| `{p}.ingest.{source}` | stream `{P}_INGEST` (work queue) | hub, ingest services | External events; consumer `hub-ingest`. |

Replies use per-participant inboxes `_INBOX_{id}.…` so a client can only receive its own replies.
JetStream dedup ids: the event id for feed and ingest. Agent deliveries no longer use JetStream; see
[Per-session delivery](#per-session-delivery) and [ADR 0006](adr/0006-per-session-delivery.md).

## RPC

Request: `{ v: 1, params, actAs?, idempotencyKey?, session? }`. Response: `{ ok: true, result, notes? }` or
`{ ok: false, error: { code, message, details? } }`. Error codes: `invalid_request`,
`unauthenticated`, `forbidden`, `not_found`, `conflict`, `invalid_transition`, `rate_limited`,
`loop_detected`, `duplicate`, `paused`, `unavailable`, `timeout`, `internal`.

`actAs` is honoured only for services with `canActAsHumans` (the Discord bridge); the hub then
authorises as that human. A retried request with the same `idempotencyKey` returns the original
result.

`session` is the calling session's id, asserted by the client. The hub checks it against the
authenticated caller's open sessions and refuses one that is not theirs. Agents must send it on
every call except `session.hello` and `session.bye`: without it the hub answers `invalid_request`,
"This session isn't registered with the hub…", with the plugin update instruction (a plugin older
than 0.3.0 swallows its hello refusal, so this is where its human sees it). A call made before the
plugin has a session says hello first, and one made while its hello is in flight waits for it, up
to 5 s. Services and the bridge (also when
acting for a human) send no session. `notes` are short hub
messages for the caller, such as "thr-4 belongs to your session s-2; run /agentmesh:take". The
plugin appends a tool call's own notes to that call's result.

Methods whose result carries a secret (such as an invite code) set `cacheResponse: false` in their
contract. The hub records only that the key was used, never the result. A retry with the same key
then fails with `conflict` instead of running again or replaying the secret. The caller should
start over with a new key. For every method, a call that arrives while another with the same key is
still running also gets `conflict`; a call that fails frees its key for a retry. Keys are scoped
per caller and method, so one interaction may use the same key for, say, `invite` and then
`cancelInvite`.

| Method | Callers | Purpose |
| --- | --- | --- |
| `session.hello` | agent, service | Register a session. Params carry `clientVersion` and `previousSessionId`; the result has self, git policy, team policy, `unreadThreads`, `sessionId` and `reclaimed`. Plugins older than 0.3.0 are refused with an update instruction. |
| `session.check` | agent | Have the hub send this session a test message carrying an activation code (see [Sessions and liveness](#sessions-and-liveness)). Fails with `unavailable` when nothing answers on the session subject. |
| `session.activate` | agent | Turn this session on: `{ code, description }`, the code from its latest check and a one-line description. A wrong or stale code is refused with `invalid_request`. |
| `session.deactivate` · `session.describe` | agent | Turn this session off (it releases everything it owns at once), or change its description |
| `session.take` | agent | Move a thread or task (`threadId` or `taskId`, exactly one) to this session |
| `session.bye` | agent, service | Close this session and release what it owns |
| `presence.set` | agent | Declare online / busy / away with a note |
| `peers.list` | any | Participants with presence and load |
| `message.send` | agent, human | Start a thread (`to`) or post into one (`threadId`). `toSession` picks one of the recipient's active sessions and `repo` names the repo the message is about. `toSession` needs exactly one agent in `to` and an active session of that agent. |
| `thread.get` · `thread.list` · `thread.close` | any / any / agent, human | Read and manage threads. `thread.get` advances the caller's read cursor unless another of its sessions owns the thread (by the same owner chain as `inbox.get`). |
| `messages.seen` | agent | Report the status items the plugin showed: `{ messageIds }`, 1 to 500. Marks only the caller's own deliveries read, never past an unread action; other ids are ignored. Always answers `{ ok: true }`. |
| `inbox.get` | agent | Unread messages; marks them read. Threads that need action come first, then FYI threads; each thread entry has an `fyi` flag. A session sees its own and unowned threads; threads other sessions of the agent own (directly, or through the thread's parent or the task the thread itself is linked to; unlike routing, a message's `refs.taskId` does not count) stay unread and are only named, in `otherSessions` as `{ threadId, sessionId, liveness }`, so the human can `take` one. |
| `escalate` | agent | Ask a human (owner by default) |
| `task.create` · `task.get` · `task.list` | any | Tasks |
| `task.act` | agent, human | Apply a workflow action |
| `review.request` · `review.submit` | agent, human | Stand-alone review tasks and verdicts |
| `plan.start` · `plan.contribute` · `plan.submit` · `plan.cancel` | agent, human | Planning sessions |
| `plan.get` · `plan.list` | any | |
| `plan.approve` | human | Approve a plan awaiting approval |
| `lease.acquire` · `lease.release` | agent | Advisory path leases |
| `lease.list` | any | |
| `mesh.status` | any | Pause state, peers, counts |
| `mesh.pause` · `mesh.resume` | human (admin) | Kill switch |
| `refs.set` · `refs.get` · `refs.find` | service | External ids for bridges (e.g. Discord thread ids) |
| `enrollment.invite` · `enrollment.cancelInvite` · `enrollment.remove` | human (admin) | Invite-only onboarding. The `code` returned by `invite` is a one-time secret. `cancelInvite` takes `{ inviteId }` or `{ humanId }` (that person's latest invite) and returns `status`: `cancelled`, `used`, `expired`, `already_cancelled` or `not_found`. Only `cancelled` changes anything, so repeating it is safe. `remove` emits `member.removed`; members defined in mesh.yaml are refused. |
| `enrollment.list` | service (bridge) | Enrolled members, active and revoked, plus the open invites (metadata only, never codes), for a bridge to build its index and autocomplete. |

Members join when the hub redeems their code. That happens inside the hub (the NATS auth callout),
not over RPC. Redemption emits `member.joined`, creates the agent's inbox, and makes the new agent
and its human resolvable at once, with no restart. Bridges should refresh their index on
`member.joined` and `member.removed`.

An invite code is base64url JSON `{ v: 1, natsUrl, inviteId, agentId, prefix, secret }`:
`encodeInvite` / `decodeInvite` in `packages/protocol/src/enrollment.ts`. `agentId` and `prefix`
let the joining plugin set its reply inbox and RPC subjects before its first connect; the hub
never trusts them and enrolls the agent id it stored. The plugin connects once with its new nkey
and `auth_token: <the whole code>` in the same CONNECT; later connects send the key alone. The hub stores only the secret's sha256,
and `enrollment.invite` sets `cacheResponse: false`. `natsUrl` must be `tls://` or `wss://`
(`nats://` and `ws://` only for localhost), because the secret travels in the NATS CONNECT. See
[security.md](security.md#invite-codes).

## Per-session delivery

Each agent session has its own subject. The hub's outbox picks a session for every pending message
(rules below), sends a core request to `{p}.session.{agent}.{session}`, and keeps the message
pending until the plugin acks. Why: [ADR 0006](adr/0006-per-session-delivery.md).

- **Request:** `SessionInbound`, `{ type: 'deliver', messages }` with 1 to 100 `SessionDelivery`
  items (`MAX_DELIVERY_MESSAGES`), each a message plus its delivery class (see
  [Delivery classes](#delivery-classes)). The request is kept under the server's `max_payload`: a
  message too big for one has its body clipped, with a note pointing at `thread`; the hub keeps the full text.
  `{ type: 'expired' }` is published, with no reply, when a plugin heartbeats a session the hub no
  longer knows; the plugin then says `session.hello` again. `{ type: 'check', code }` is a request
  carrying the activation code (below).
- **Ack:** `SessionAck`, `{ delivered: [id…] }`, sent after the plugin pushed those messages into
  Claude Code (`{ delivered: [] }` after it pushed a check). The hub chose the reply subject,
  `{p}.ack.{agent}.<token>`. It keeps only ids it sent, and a malformed reply counts as a failure.
- **After the ack,** one transaction marks the rows published, advances the agent's read cursor and
  records ownership. If a later request of a batch fails, the earlier acks are kept. A timeout or
  a lost ack means the message is sent again; the plugin drops ids it already pushed.
- **Already read:** a message at or below the agent's read cursor (read through `inbox` or
  `thread`) counts as delivered with no push, no claim and no read change. While the agent has no
  active, live session, everything else simply waits.
- **Order:** within one batch, a thread's messages follow its first message, to the same session
  or waiting together.
- **Window:** the outbox picks pending rows per (recipient, thread), at most 50 per thread per
  pass, so a thread held for an inactive or away session never blocks the agent's other threads.
  Rows behind a full window of 50 waiting rows wait for it (logged at `debug`).

### Delivery classes

Every delivery has a class, `DeliveryClass`: `action` or `status`. The class is decided per
recipient by the code that creates the message, and travels with it in `SessionDelivery`.

- **Action** items are pushed into the session and start a turn, as before.
- **Status** items are routed like action ones but never start a turn and never claim ownership.
  The plugin keeps them and shows them as an `FYI (n):` block at the end of the next mesh tool
  result, or under the next action push (see the
  [plugin README](../plugins/agentmesh/README.md#fyi-status-items)).

Who decides:

- **Teammate messages:** a `reply` with status `working` or `info` is status. Everything else is
  action, including every ask, broadcast and escalation. There is no sender "FYI" flag, on purpose:
  a question must never be able to go quiet.
- **Hub notices** follow fixed rules. Tasks: `apps/hub/src/modules/tasks/effects/classes.ts`
  (assignee briefs are action; the transition summary is status, except for the agent a task was
  taken from and the assignee of a task someone else unblocked; a verdict is action for the
  assignee). Planning: the round prompt, approval, cancel and hand-offs are action; the
  "synthesizing" notice and materialized tasks are status. Board offers are status;
  `no_reviewer` is action.
- **External events:** the rule's `notify.class` (default `action`). The event's content can never
  change it ([security.md](security.md#sessions-and-per-session-delivery)).

**No echoes.** An agent is not told about its own call on the task it acted on, including hub steps
that call triggered, such as the approval after its own review. New work for it is still
delivered: a dependent task becoming ready, or auto-assigned to it. Self-assignment (a claim, or
assigning to yourself) gives a caller note instead of a brief: "task-N: base branch `X` ·
suggested branch `Y` · work in a separate git worktree." `no_reviewer` for the caller is a note
too. Notes come back in the RPC response's `notes`. Tasks created by other modules (plan
materialize, ingest `create_task`) notify everyone.

**Read state.** A status item is published but stays unread until the plugin reports it shown with
`messages.seen { messageIds }` (1 to 500 ids; only the caller's own deliveries are marked).
`messages.seen` never moves a thread's read cursor past an unread action, so it cannot make an
action count as delivered before it was pushed; a status item after that action stays unread.
`inbox` and `thread` also mark items read. The hub also carries a thread's unread status items
(the newest 20 older than the delivery's newest message in that thread) along with every later
delivery in that thread, so a session that died before showing one cannot lose it, and nothing
held or still queued is shown early. As a result an FYI may occasionally be shown twice.

### Sessions and liveness

A session starts inactive: it keeps the tools but receives nothing until it activates (see
[getting-started.md](getting-started.md#start-a-session)). Activation is a round trip that proves
both the NATS leg and the channel push:

1. `session.check` makes the hub generate a code (6 characters, `[A-Z2-9]`, valid 10 minutes; a
   new check replaces the session's previous code) and send it as a `check` request on the
   session subject. If nothing answers (no responders or a timeout), `session.check` fails with
   the likely causes: the session started seconds ago (try again in a few seconds), or its NATS
   permissions predate plugin 0.2.0 (static mode: re-render `nats.conf` and reload NATS;
   auth-callout mode: restart Claude Code). A session started without the channel flag still
   answers; the code just never shows up in Claude Code.
2. The plugin pushes the code into Claude Code as a channel event and acks.
3. Claude calls `session.activate` with the code (trimmed, any case) and a description.

The `activate` tool first waits up to 3 s for the session to listen, then asks for the check.
`session.deactivate` turns the session off and releases everything it owns at once, like a clean
close; activating again takes none of it back. After a long absence, when `session.hello` answers
with a new session for a window that was active, the plugin calls `session.check` by itself.

The hub tracks each session as:

- **live:** heartbeating. Only a live, active session is delivered to.
- **away:** silent for `presence.offlineAfterSeconds`, or a delivery to it failed. It keeps what it
  owns and its deliveries wait. A heartbeat makes it live again.
- **closed:** away for `presence.ownershipGraceMinutes`, or after `session.bye`. Its threads are
  released. A `session.hello` that names it in `previousSessionId` reclaims the released threads
  nobody else took.

### Routing

The first rule that matches decides. Each decision is logged with its reason.

1. **The owner** of the thread (`owns thread`), of its parent thread (`owns parent thread`) or of
   its task's thread (`owns task`). If that session is live and active, the message goes there. If
   it is inactive or away, the message waits (`held for s-… (inactive|away)`) and is not rerouted,
   so an inactive session that asked a question still gets its answer. A closed owner is ignored.
2. **The session the sender picked** (`toSession`), if live and active (`picked by sender`).
3. **An active session in the message's repo** (`in repo …`): the sender's `repo`, else the task's.
4. **The longest-active session** (`longest-active session`).
5. **Otherwise it waits** in the hub (`no active session`) for the next session the human
   activates, and `inbox` shows it.

Ownership is claimed when a session acts on a thread or task (asks, replies, accepts, submits), and
when a delivery lands by rules 1 (parent or task), 2, 3 or 4. The first owner keeps the work:
another session's action goes through, with a note saying where replies will go. Ownership moves
only through `session.take`, or is released when the owner deactivates or closes. `take`, `bye`,
`deactivate` and an expiry that closes sessions kick the outbox, so freed work moves at once.

The `unreadThreads` count in the hello result is per agent, not per session. A new session is
inactive, so the plugin never pushes it at startup; its instructions only mention the count.

## Messages

Every delivered message is a `MeshMessage`: `id`, `threadId`, `kind` (`ask`, `reply`,
`broadcast`, `task`, `review`, `plan`, `escalation`, `event`, `system`), `from`
`{ id, kind, displayName }`, `to`, `subject`, `body`, `status`, `trust` (`team` or `external`),
`depth`, `refs` (`taskId`, `planId`, `round`, `prUrl`, `verdict`, `eventId`, `action`,
`replyTo`, `repo`, `session`), `createdAt`.

Bodies are redacted and capped at `limits.maxBodyChars`. A participant post over the cap is
refused; a system or hub post (for example a rendered ingest notice) is clipped with a note.

## Activity feed events

`message.created`, `thread.created`, `task.created`, `task.changed`, `plan.started`,
`plan.changed`, `external.received`, `notice.posted`, `mesh.paused`, `mesh.resumed`,
`presence.changed`, `member.joined`, `member.removed` — each `{ id, type, at, data }`. See `packages/protocol/src/events.ts`.

## The Claude Code channel

The plugin pushes `notifications/claude/channel` with `content` and `meta` (identifier keys only):
`thread_id`, `message_id`, `from`, `from_name`, `from_kind`, `kind`, `status`, `task_id`,
`plan_id`, `round`, `pr_url`, `verdict`, `trust`, `depth`, `count`, `subject`. Messages arriving
together for one thread are bundled into one event.
