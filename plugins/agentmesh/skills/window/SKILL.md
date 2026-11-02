---
name: window
description: Set up this laptop's mesh window, the one guarded Claude Code session that takes team work.
argument-hint: "[team folder]"
disable-model-invocation: true
---

Set up the mesh window: one marked, guarded Claude Code session per teammate that takes team work.
You ask a few questions and run one CLI step; the CLI writes the files.

1. From this session's AgentMesh instructions, take the agent (`You are <agent>`), the owner
   (`working for <owner>`, else the agent), and the integration branch and branch template (the
   `Git:` line). If they are missing, this laptop has not joined: stop and point the user to
   `/agentmesh:join`.
2. Ask for the team folder (default "$ARGUMENTS", else the current folder). Recommend the folder
   that holds the team's repos.
3. Ask for the exact test command lines. Explain that they run without a prompt on the window's own
   branches and with a prompt on everyone else's.
4. Run
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" window init --agent <agent> --owner <owner> --branch-template "<template>" --integration-branch <branch> --test "<test command>" --dir "<folder>"`
   (one `--test` per command line) and show its output.
5. Tell the user how to start the window each day in a terminal (the launcher path is in the
   output). They confirm the development channel, and it activates itself; if it does not, they
   type `/agentmesh:activate mesh window`.
6. Tell them to deactivate any other session they had activated, and to turn off any inbox poll
   (Claude Desktop).

Never run the launcher yourself, never edit the files it wrote, and never add permission rules.
