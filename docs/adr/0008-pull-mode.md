# ADR 0008 — Pull mode for sessions without channel pushes

**Status:** accepted · 2026-10-30. It extends [ADR 0006](0006-per-session-delivery.md).

## Context

Claude Code shows a plugin's channel pushes only in sessions started with
`--dangerously-load-development-channels plugin:agentmesh@agentmesh` (or `--channels` once the
plugin is allowlisted). The Claude Desktop app cannot pass that flag. In such a session
`/agentmesh:activate` fails, because its test message never arrives. The session stays inactive,
and since task-22 an agent without an active session counts as offline, so work routes around
it. People reported this as "AgentMesh does not work". Pushes cannot work without the flag.

## Decision

- **A session can activate in `pull` mode** (`session.activate { mode: "pull" }`), without the
  check code. The code proves that pushes arrive; a pull session gets none, so there is nothing
  to prove. Only the authenticated agent can activate its own session, as before.
- **Pull sessions are never delivered to.** A delivery's ack marks action items read and claims
  the thread, so delivering to a session nobody wakes would hide work. A delivery target must be
  active, live and `push`. A pull session's messages wait unread in the hub. Threads it owns, and
  messages whose sender picked it, are held for it. It reads them with `inbox`.
- **An agent with an active, live pull session is online.** Auto-assignment and reviewer picks
  rank agents with a push session ahead of pull-only ones. They prefer push and never require it.
- **The plugin announces unread work.** While its session is active in pull mode, the MCP server
  polls a new read-only RPC, `inbox.peek` (counts, up to 5 sender ids and an external flag; it marks
  nothing read), every 30 s and after each mesh tool call. It writes the result to a small state
  file. A plugin `UserPromptSubmit` / `SessionStart` hook (`dist/hook.js`) reads the fresh state
  files for the project and adds one line of context: how many threads are unread, from whom, and
  that Claude should call `inbox` when it fits.
- `delivery` is stored per session (migration 006, default `push`). It is shown in `SessionView`
  and in the peers session summary, defaulting to `push`, so results from older hubs still parse.

## Consequences

- Desktop sessions are usable. Work reaches them on the user's next prompt, not at once. A pull
  session that sits idle reads nothing until someone types, so routing prefers push sessions.
- The hook runs on every prompt. It imports only Node built-ins, and it prints nothing when
  there is no fresh state.
- The state file and the hook carry counts and validated ids only, never subjects or bodies
  ([security.md](../security.md#sessions-and-per-session-delivery)).
- Whether Claude Code runs plugin hooks in a given client (Desktop included) is outside our
  control. Without the hook, a pull session still works: Claude calls `inbox` when asked.
