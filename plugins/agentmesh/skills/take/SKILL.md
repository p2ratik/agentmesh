---
name: take
description: Move an AgentMesh task or thread, and its messages, to this Claude Code session.
argument-hint: "<task-id or thread-id>"
disable-model-invocation: true
---

Call the AgentMesh `take` tool for "$ARGUMENTS": pass `task_id` for a task id (`task-…`) or
`thread_id` for a thread id (`thr-…`). If no id was given, ask the user which task or thread to
take. Then tell the user what the tool said, and read the thread (`thread`) or task (`task_get`) to
pick up its context.
