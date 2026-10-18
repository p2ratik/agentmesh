# Protocol

The wire contract lives in `packages/protocol` (zod schemas). This page summarises it for people
writing new bridges, producers or clients.

## NATS topology

Prefix `p` (default `mesh`), stream names use its upper-case form (`MESH_…`).

| Subject | Kind | Who publishes | Purpose |
| --- | --- | --- | --- |
| `{p}.rpc.{caller}.{method}` | request/reply | every participant | Calls into the hub. The caller id in the subject is enforced by NATS permissions. |
| `{p}.presence.{agent}` | core publish | agents | Heartbeats `{ repo?, branch? }`. |
| `{p}.deliver.{agent}` | stream `{P}_DELIVERY` (work queue) | hub | Each agent's durable inbox; consumer `inbox-{agent}`. |
| `{p}.evt.{type}` | stream `{P}_EVENTS` (limits, 7 days) | hub | Activity feed; bridges read it with consumer `feed-{service}`. |
| `{p}.ingest.{source}` | stream `{P}_INGEST` (work queue) | hub, ingest services | External events; consumer `hub-ingest`. |

Replies use per-participant inboxes `_INBOX_{id}.…` so a client can only receive its own replies.
JetStream dedup ids: `{messageId}:{recipient}` for deliveries, the event id for feed and ingest.

## RPC

Request: `{ v: 1, params, actAs?, idempotencyKey? }`. Response: `{ ok: true, result }` or
`{ ok: false, error: { code, message, details? } }`. Error codes: `invalid_request`,
`unauthenticated`, `forbidden`, `not_found`, `conflict`, `invalid_transition`, `rate_limited`,
`loop_detected`, `duplicate`, `paused`, `unavailable`, `timeout`, `internal`.

`actAs` is honoured only for services with `canActAsHumans` (the Discord bridge); the hub then
authorises as that human. A retried request with the same `idempotencyKey` returns the original
result.

Methods whose result carries a secret (such as an invite code) set `cacheResponse: false` in their
contract. The hub records only that the key was used, never the result. A retry with the same key
then fails with `conflict` instead of running again or replaying the secret. The caller should
start over with a new key.

| Method | Callers | Purpose |
| --- | --- | --- |
| `session.hello` | agent, service | Register a session; returns self, git policy, team policy, unread count |
| `session.bye` | agent, service | Mark offline |
| `presence.set` | agent | Declare online / busy / away with a note |
| `peers.list` | any | Participants with presence and load |
| `message.send` | agent, human | Start a thread (`to`) or post into one (`threadId`) |
| `thread.get` · `thread.list` · `thread.close` | any / any / agent, human | Read and manage threads |
| `inbox.get` | agent | Unread messages; marks them read |
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
| `enrollment.invite` · `enrollment.cancelInvite` · `enrollment.remove` | human (admin) | Invite-only onboarding. The `code` returned by `invite` is a one-time secret. *Contract only; the hub handlers are in progress.* |
| `enrollment.list` | service | Enrolled members, for a bridge to build its index. *Contract only.* |

An invite code is base64url JSON `{ v: 1, natsUrl, inviteId, secret }`: `encodeInvite` /
`decodeInvite` in `packages/protocol/src/enrollment.ts`. The hub stores only the secret's sha256.

## Messages

Every delivered message is a `MeshMessage`: `id`, `threadId`, `kind` (`ask`, `reply`,
`broadcast`, `task`, `review`, `plan`, `escalation`, `event`, `system`), `from`
`{ id, kind, displayName }`, `to`, `subject`, `body`, `status`, `trust` (`team` or `external`),
`depth`, `refs` (`taskId`, `planId`, `round`, `prUrl`, `verdict`, `eventId`, `action`,
`replyTo`), `createdAt`.

## Activity feed events

`message.created`, `thread.created`, `task.created`, `task.changed`, `plan.started`,
`plan.changed`, `external.received`, `notice.posted`, `mesh.paused`, `mesh.resumed`,
`presence.changed`, `member.joined`, `member.removed` — each `{ id, type, at, data }`. See `packages/protocol/src/events.ts`.

## The Claude Code channel

The plugin pushes `notifications/claude/channel` with `content` and `meta` (identifier keys only):
`thread_id`, `message_id`, `from`, `from_name`, `from_kind`, `kind`, `status`, `task_id`,
`plan_id`, `round`, `pr_url`, `verdict`, `trust`, `depth`, `count`, `subject`. Messages arriving
together for one thread are bundled into one event.
