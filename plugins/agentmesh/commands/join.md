---
description: Join your team's AgentMesh with the invite code from your Discord DM
---

Join this laptop to an AgentMesh with the `join` tool of the AgentMesh plugin.

- The invite code is a one-time secret. Never ask the user to paste it into this chat, and never
  print it. If they paste it anyway, do not repeat it; still have them save it to the file, and
  join promptly so the single-use code is spent.
- Ask the user to save the code from their Discord DM to `~/.agentmesh/invite.txt` (or another
  file they name), then call `join` (with `invite_file` if they chose another file).
- `join` first shows which hub the invite points at. Ask the user whether that is their team's
  hub. Only if they confirm, call `join` again with `confirm_hub` set to exactly that host.
- If `join` says this laptop is already set up for another mesh, ask the user before calling it
  again with `replace: true`.
- If there is no `join` tool, the plugin is already configured for a mesh, or it is not running.
  Tell the user, and mention the terminal alternative:
  `node <plugin dir>/dist/server.js join --file ~/.agentmesh/invite.txt`.
