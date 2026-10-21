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
- **Ownership is claimed when a session acts or receives**, in the same transaction that
  marks the delivery published. The first owner keeps the work until it closes or the human runs
  `/agentmesh:take`.
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
  concurrently and takes up to 200 pending rows per recipient per flush.
- **Delivery needs the hub up.** RPCs always did.
- **Sessions of one agent share NATS permissions.** See the threat note in
  [security.md](../security.md#sessions-and-per-session-delivery).
- **Upgrade.** On start the hub deletes the leftover `{P}_DELIVERY` stream. Anything still queued
  there is not pushed, but it is in the hub database and reachable through `inbox`. The hub refuses
  `session.hello` from plugins older than 0.2.0, so the hub and every plugin upgrade together;
  there is no compatibility mode.

## Alternatives considered

- **Per-session JetStream consumers.** Rejected: permissions cannot scope per-session consumer
  names, and the hub would have to create and clean up a consumer per session.
- **`allow_responses` for the plugin's ack.** Rejected: it differs between the static `nats.conf`
  and auth-callout JWTs. Scoped `{p}.ack.{agent}.>` publish permission works the same in both.
- **One mesh session per agent, notify-all-and-claim, an unscoped pick by the sender, and a
  hub-side model choosing the session.** Rejected in the design, §8.
