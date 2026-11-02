# ADR 0009 — Team work belongs to a session that can take it

**Status:** accepted · 2026-11-02; part 1 of 3 built (reads and ownership). It amends
[ADR 0006](0006-per-session-delivery.md) ("reads claim nothing") and
[ADR 0008](0008-pull-mode.md) ("a pull session cannot hide work"). The design is
[the mesh window](../specs/2026-11-01-mesh-window-design.md).

## Context

A request for Aheen's agent went missing. Aheen uses Claude Desktop, which runs in pull mode, and
had it check the inbox every 5 minutes. A poll that ran in an unrelated project called `inbox.get`.
That call returned every unread thread nobody owned to any session of the agent, active or not, in
any project. It moved the agent-wide read cursor past them and claimed nothing. From then on no hook
line, no other session and no reminder showed the request again.

Three gaps made it easy:

- An inactive session could read and mark read work it could never act on.
- `thread` marked unowned threads read as well.
- `/mesh pause` held pushes but not reads.

ADR 0008 said a pull session "cannot hide work" because it is never delivered to. That holds for
deliveries, not for reads.

## Decision

Part 1 changes who may take unowned work. The relay and the mesh window itself come in plans 2 and 3.

- **Only a session that may take unowned work reads it, and marks it read.** That is an active push
  session, or an active pull session while the agent has no ready push session. Any other session
  (inactive, or pull while a push session is ready) reads only the threads it owns. One shared
  reader, `takeUnownedReader` in `apps/hub/src/modules/sessions/readers.ts`, is wired into
  messaging as `mayTakeUnowned`, and every read uses it.
- **Inactive sessions are told what waits.** `inbox.get` and `inbox.peek` return `waiting`: unowned
  unread threads this session may not take. The plugin's `inbox` tool says so.
- **`thread` marks read only what the session owns.** On a thread it does not own, it only looks.
  Callers without a session (humans, services) still mark read.
- **Pause stops consuming.** While `/mesh pause` is on, a read by a caller with a session only
  looks: `inbox.get` returns `paused: true` and advances nothing, and `thread` adds the note "The
  mesh is paused: nothing was marked read." Callers without a session are unaffected.
- **An active session's `inbox.get` claims the non-FYI threads it returns,** none while paused. A
  read that consumes work makes the reader its owner, so follow-ups go to the session that has the
  context. This amends ADR 0006: reads no longer claim nothing. It runs through the router's atomic
  claim path (`claims.ts`), so the read and the claims commit together.
- **An inactive session claims only its own conversations.** It claims through `message.send` on a
  `conversation` thread and `escalate` on an `escalation` thread. Its `task.*`, `review.*` and
  `plan.*` actions, and its replies into task, planning or event threads, claim nothing, so those
  threads stay unowned and route to an active session (`claimsWhenInactive`).
- **Routing skips an inactive owner reached through the chain.** An inactive session that owns the
  parent thread or the task no longer holds the work: routing falls through to the sender's pick,
  the repo and the longest-active rules. A thread's direct owner (in any state) still holds its
  conversation, and so do away or pull owners reached through the chain.

Still to come:

- Plan 2: the relay, which carries an answer to the private session that asked.
- Plan 3: the mesh window, the one activated push session per teammate that takes team work.

## Consequences

- Inactive sessions only count team work. They cannot swallow it, so a private session no longer
  hides a teammate's request from the session that can act on it.
- A pull session takes unowned work only while no push session of the agent is ready. Pull mode
  still works for Claude Desktop users who have no push session.
- `thread` no longer marks unowned threads read. Consuming happens in `inbox`, where it also claims.
  A thread the session owns is unchanged.
- A session can still take work by acting: `take`, or a reply into an unowned conversation thread.
  Both are deliberate.
- `messages.seen` is unchanged. It can never pass an unread action.
- Without a mesh window, a request for an agent whose sessions are all inactive waits in the hub
  until someone activates a session. `waiting` and the plugin's `inbox` text tell the human.
- Tests that pinned the old behaviour (an inactive read of an unowned thread, "claims nothing for
  reads", the dispatcher's read-then-publish case) changed on purpose.
- The threat note is in [security.md](../security.md#sessions-and-per-session-delivery).
