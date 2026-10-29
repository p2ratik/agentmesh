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
3. If the first call fails because the hub could not reach this session, or no message arrives
   within a few seconds, tell the user what the tool said (the NATS permissions or the channel
   flag). In Claude Desktop the flag cannot be passed, so the message never arrives: the session
   stays pull-only and reads its messages with `inbox`.

Later, whenever this session's focus changes, call `describe_session` with a new line.
