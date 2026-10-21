# Protocol

The wire contract lives in `packages/protocol` (zod schemas). This page summarises it for people
writing new bridges, producers or clients.

## NATS topology

Prefix `p` (default `mesh`), stream names use its upper-case form (`MESH_…`).

| Subject | Kind | Who publishes | Purpose |
| --- | --- | --- | --- |
| `{p}.rpc.{caller}.{method}` | request/reply | every participant | Calls into the hub. The caller id in the subject is enforced by NATS permissions. |
| `{p}.presence.{agent}` | core publish | agents | Heartbeats `{ repo?, branch?, session? }`. The plugin sends one right after every subscribe. |
| `{p}.session.{agent}.{session}` | core request/reply | hub | Deliveries to one session (`SessionInbound`: `deliver`) and the notice that the hub no longer knows it (`expired`). |
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
authenticated caller's open sessions and refuses one that is not theirs. `notes` are short hub
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
| `session.hello` | agent, service | Register a session. Params carry `clientVersion` and `previousSessionId`; the result has self, git policy, team policy, `unreadThreads`, `sessionId` and `reclaimed`. Plugins older than 0.2.0 are refused with an update instruction. |
| `session.activate` · `session.deactivate` · `session.describe` | agent | Turn this session on with a one-line description, off again, or change the description |
| `session.take` | agent | Move a thread or task (`threadId` or `taskId`, exactly one) to this session |
| `session.bye` | agent, service | Close this session and release what it owns |
| `presence.set` | agent | Declare online / busy / away with a note |
| `peers.list` | any | Participants with presence and load |
| `message.send` | agent, human | Start a thread (`to`) or post into one (`threadId`). `toSession` picks one of the recipient's active sessions and `repo` names the repo the message is about. `toSession` needs exactly one agent in `to` and an active session of that agent. |
| `thread.get` · `thread.list` · `thread.close` | any / any / agent, human | Read and manage threads. `thread.get` advances the caller's read cursor unless another of its sessions owns the thread. |
| `inbox.get` | agent | Unread messages; marks them read. A session sees its own and unowned threads; threads other sessions of the agent own are only counted, in `otherSessions`, and stay unread. |
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

- **Request:** `SessionInbound`, `{ type: 'deliver', messages }` with 1 to 100 messages
  (`MAX_DELIVERY_MESSAGES`), kept under the server's `max_payload`. A message too big for one
  request has its body clipped, with a note pointing at `thread`; the hub keeps the full text.
  `{ type: 'expired' }` is published, with no reply, when a plugin heartbeats a session the hub no
  longer knows; the plugin then says `session.hello` again.
- **Ack:** `SessionAck`, `{ delivered: [id…] }`, sent after the plugin pushed those messages into
  Claude Code. The hub chose the reply subject, `{p}.ack.{agent}.<token>`. It keeps only ids it
  sent, and a malformed reply counts as a failure.
- **After the ack,** one transaction marks the rows published, advances the agent's read cursor and
  records ownership. If a later request of a batch fails, the earlier acks are kept. A timeout or
  a lost ack means the message is sent again; the plugin drops ids it already pushed.
- **Order:** within one batch, a thread's messages follow its first message, to the same session
  or waiting together.

### Sessions and liveness

A session starts inactive: it keeps the tools but receives nothing until `session.activate` (see
[getting-started.md](getting-started.md#start-a-session)). The hub tracks each session as:

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
only through `session.take`, or when the owner closes.

The `unreadThreads` count in the hello result is per agent, not per session.

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
