---
name: window
description: Set up this laptop's mesh window, the one guarded Claude Code session that takes team work.
argument-hint: "[team folder]"
disable-model-invocation: true
---

Set up the mesh window: one marked, guarded Claude Code session per teammate that takes team work.
You ask a few questions and run one CLI step; the CLI writes the files.

1. Take the agent (`You are <agent>`), the owner (`working for <owner>`, else the agent), and the
   integration branch and branch template (the `Git:` line) from this session's AgentMesh
   instructions, or from the result of the `join` or `connect` tool in this conversation. If
   neither names them, stop and tell the user to start a new Claude Code session and run
   `/agentmesh:window` there; if this laptop hasn't joined a mesh yet, `/agentmesh:join` comes
   first.
2. Ask for the team folder (default "$ARGUMENTS", else the current folder). Recommend the folder
   that holds the team's repos.
3. Ask for the exact test command lines. Explain that they run without a prompt on the window's own
   branches and with a prompt on everyone else's. Suggest the repo’s install command (such as
   `pnpm install --frozen-lockfile`) as one of them: a new worktree has no dependencies. Use only
   the commands the user gives; if they give none, leave out `--test`.
4. Run
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" window init --agent <agent> --owner <owner> --branch-template "<template>" --integration-branch <branch> --test "<test command>" --dir "<folder>"`
   (one `--test` per command line) and show its output. If it prints an error, show the error to
   the user and stop; don't retry with other values. The window starts in Claude Code's auto mode
   by default; add `--mode manual` only when the user has asked to review every command
   themselves. Don't ask about it up front: step 8 tells them.
5. Give the user the line the output prints for starting the window each day in a terminal
   (`Start it each day in any folder: claude-mesh …`), exactly as printed. If the output also
   prints a line saying a folder is not on their PATH, or a `Warning: claude-mesh runs …` line,
   give them that line and the launcher lines after it exactly as printed too. They confirm the development channel, and it activates
   itself; if it does not, they type `/agentmesh:activate mesh window`.
6. Tell them to deactivate any other session they had activated, and to turn off any inbox poll
   (Claude Desktop).
7. Tell them how answers reach their private sessions. On Windows, the window passes each one a
   pointer through Claude Code's cross-session messaging, which needs Claude Code 2.1.234 or later
   and `crossSessionInbound` unset or `accept`; a private session in bypass mode holds the
   pointer. Elsewhere, and whenever messaging is off, an AgentMesh line on that session's next
   prompt says a reply waits.
8. In your final summary, say which mode the window starts in (the output's `It starts in …`
   line). In auto mode, commands not on the window's list go to auto mode's checks; pushes other
   than its own branch's, merges, rebases, branch deletes, hard resets and infra commands still ask
   them, and where auto mode isn't available (plan, model or an admin setting) it starts in manual
   mode. Secrets and personal data are refused in every mode. A teammate who wants to review every
   command runs `/agentmesh:window` again and asks for manual mode (`--mode manual`).

Never run the launcher yourself (nor `claude-mesh`), never edit the files it wrote, and never add permission rules.
