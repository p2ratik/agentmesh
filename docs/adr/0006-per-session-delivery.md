# ADR 0006 — Per-session delivery through the hub outbox

**Status:** accepted · 2026-10-21. It supersedes the per-agent inbox consumer of
[ADR 0001](0001-nats-jetstream.md).

## Context

Until now each agent had one durable JetStream consumer, `inbox-{agent}`, and every Claude Code
session of that agent pulled from it. A person runs many sessions at once, and the first one to
pull took the message. During the 2026-10-18 to 2026-10-20 test run this lost messages:

- A session started without the channel flag still pulled and acked. Claude Code dropped the push
  silently, so the message was gone from the queue. On 2026-10-20 five of nine messages never
  reached the working session; on 2026-10-18 four were lost the same way.
- A message that did land could land in a session that knew nothing about the work.

The full evidence is in the [design](../specs/2026-10-21-session-routing-design.md#1-why).

## Decision

- **The hub's SQLite outbox is the agent queue.** A delivery row stays pending until a session has
  acked it. The `{P}_DELIVERY` stream and the `inbox-{agent}` consumers are removed.
- **The hub sends a core NATS request** to `{p}.session.{agent}.{session}`. The plugin pushes the
  messages into Claude Code and replies with the ids it took. The hub picks the reply subject,
  `{p}.ack.{agent}.<random token>`, and sends the request with `noMux`, so an agent may answer only
  on its own `{p}.ack.{agent}.>`.
- **The hub routes every message to one session** with a pure function (design §3): the owner of
  the thread, its parent or its task; else the session the sender picked; else a session in the
  message's repo; else the longest-active session; else it waits in the hub. Only active, live
  sessions receive anything. Every decision is logged with its reason.
- **Ownership is claimed by two things,** each in the transaction of what caused it:
  - **An RPC that acts on a thread,** in the RPC's transaction: `message.send` (an ask or a
    reply), `escalate`, `task.create`, `task.act`, `review.request`, `review.submit`,
    `plan.start`, `plan.submit` and `plan.cancel` claim the thread their result names;
    `plan.contribute` claims the plan's thread. Reads (`thread.get`, `inbox.get`, `task.get`, …)
    claim nothing.
  - **A delivery the session acked,** in the transaction that marks it published, when routing
    chose the session as the owner of the parent thread or the task, as the sender's pick, by repo
    or as the longest-active session. A delivery to the thread's own owner claims nothing new.

  A claim never moves work an open session owns: the first owner keeps it, and an acting session
  gets a note saying where replies go. Ownership moves only by `/agentmesh:take`, or is released
  when the owner deactivates or closes.
- **Activation is a hub-sent check.** `session.check` makes the hub send the session a code over
  its session subject; the plugin pushes it into Claude Code, and `session.activate` takes it back
  with the description. A session that cannot be reached over NATS, or whose pushes Claude never
  sees, never activates.
- **Agents call as a session.** The hub refuses agent RPCs without an envelope session, except
  `session.hello` and `session.bye`, with the plugin update instruction.
- **What the agent already read is never pushed.** A pending delivery at or below the agent's read
  cursor (read through `inbox` or `thread`) is marked published without a push.
- **Mechanics.**
  - A request carries at most 100 messages (`MAX_DELIVERY_MESSAGES`) and stays under the server's
    `max_payload`.
  - A single message too big to send has its body clipped, with a note pointing at
    `thread(thread_id: "...")`. The full text stays in the hub database.
  - If a later request of a batch fails, the acks of the earlier ones are kept and the rest waits.
  - Within one batch, a thread's messages follow its first message: to the same session, or they
    wait together.

## Consequences

- **The transactional outbox ([ADR 0004](0004-sqlite-transactional-outbox.md)) holds end to end,
  with no dual write.**
  - Producer side: the state change and its deliveries and events commit in one SQLite
    transaction, as before.
  - Consumer side: "published", "read" and "owned" commit in one transaction after the plugin's
    ack.
  - Claims: an RPC's action and the ownership it creates commit in one transaction.
- **Delivery is at-least-once.** If the hub crashes between the plugin's push and that commit, or
  an ack is lost or late, the message goes out again and the plugin drops ids it already pushed.
  A message that starts a new conversation could reach a second session only in that crash or
  timeout window. Nothing is lost.
- **Ordering** is per thread per agent, kept by the dispatcher. The outbox runs recipients
  concurrently and takes up to 200 pending rows per recipient per flush. If all 200 wait for a held
  session, the agent's later rows wait behind them; the hub warns once a minute. A per-thread
  window is later work (plan 2). Plan 2 did it: see "Plan 2" below.
- **Delivery needs the hub up.** RPCs always did.
- **Sessions of one agent share NATS permissions.** See the threat note in
  [security.md](../security.md#sessions-and-per-session-delivery).
- **Upgrade.** On start the hub deletes the leftover `{P}_DELIVERY` stream. Anything still queued
  there is not pushed, but it is in the hub database and reachable through `inbox`. The hub refuses
  `session.hello` from plugins older than 0.2.0, and their later sessionless calls, so the hub and
  every plugin upgrade together; there is no compatibility mode. Agents need new NATS permissions:
  a static `nats.conf` is re-rendered and reloaded before the hub restarts, and in auth-callout
  mode plugins reconnect for a new JWT ([deploy.md](../deploy.md#operations)).

## Plan 2: delivery classes

- **Classes.** Each delivery is `action` or `status`, decided per recipient by the code that
  creates it. Status never starts a turn and never claims ownership; the plugin shows it as an
  `FYI (n):` block with the next mesh tool result. A teammate message is status only as a
  `working`/`info` reply, so a question can never go quiet. An agent is not told about its own
  call (echoes); a consequence it must learn becomes a note on its tool result.
- **Ride-along.** A status item is published but stays unread until the plugin reports it shown
  (`messages.seen`). A later delivery in its thread carries along the thread's unread status
  items (newest 20), so one lost with a dead session is not lost. The cost: an FYI can be shown
  twice, accepted for FYI.
- **Per-thread window.** The outbox picks pending rows per (recipient, thread), 50 per thread, so
  a held thread no longer blocks the agent's others. This replaces the 200-per-recipient limit.
- Hub minimum plugin version: 0.3.0. Details: [protocol.md](../protocol.md#delivery-classes).

## Alternatives considered

- **Per-session JetStream consumers.** Rejected: permissions cannot scope per-session consumer
  names, and the hub would have to create and clean up a consumer per session.
- **`allow_responses` for the plugin's ack.** Rejected: it differs between the static `nats.conf`
  and auth-callout JWTs. Scoped `{p}.ack.{agent}.>` publish permission works the same in both.
- **One mesh session per agent, notify-all-and-claim, an unscoped pick by the sender, and a
  hub-side model choosing the session.** Rejected in the design, §8.
