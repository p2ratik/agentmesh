---
name: activate
description: Turn this Claude Code session on for the AgentMesh, so teammates' messages and tasks reach it.
argument-hint: "[one-line description of this session's work]"
disable-model-invocation: true
---

Turn this session on for the mesh with the AgentMesh `activate` tool.

1. Call `activate` with no arguments. The hub sends this session a test message with a code.
2. Wait for that message (`AgentMesh activation check. Code: …`). Then call `activate` again with
   `code` set to that code and `description` set to one line on what this session is working on:
   "$ARGUMENTS" if the user typed one, otherwise a line you write from this conversation, e.g.
   "checkout redesign in acme/web". Teammates see it when they pick a session.
3. If no message arrives within a few seconds, this session was started without the channel flag
   (Claude Desktop can never pass it). Call `activate` with `pull: true` and the same
   `description`. Then tell the user the session is pull-only: nothing is pushed, new mesh
   messages are announced on each prompt and read with `inbox`, and for instant pushes they can
   restart it with `claude --dangerously-load-development-channels plugin:agentmesh@agentmesh`.
4. If the first call fails because the hub could not reach this session, tell the user what the
   tool said (try again in a few seconds, or the NATS permissions are outdated).

Later, whenever this session's focus changes, call `describe_session` with a new line.
