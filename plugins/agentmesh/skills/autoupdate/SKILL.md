---
name: autoupdate
description: Turn automatic updates on (or off) for the AgentMesh plugin.
argument-hint: "[off]"
disable-model-invocation: true
---

Turn Claude Code's automatic plugin updates on for the AgentMesh marketplace. Claude Code leaves
them off for third-party marketplaces, so without this the plugin stays on the version it was
installed at.

1. If the user's argument is `off` ("$ARGUMENTS"), run
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" autoupdate --off`. Otherwise run
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" autoupdate`. Show the user the line it printed.
2. It changes only the `agentmesh` entry under `extraKnownMarketplaces` in the user's own Claude
   Code `settings.json`. Never open, read or print that file, and never add permission allow rules
   for this command.
3. If it fails, show its message. The same switch is in `/plugin` → Marketplaces → agentmesh →
   Enable auto-update.
4. Tell the user that new versions download in the background and load after `/reload-plugins` or
   a restart.
