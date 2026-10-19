# Spike: can the plugin start without agent_id and nats_url? (task-7, plan-1)

**Question.** If `agent_id` and `nats_url` are not `required` in `plugin.json`, does Claude Code
start the plugin's MCP server, so an unenrolled laptop can be offered a `join` tool?

**What the code and current behaviour show.**
- Claude Code holds back a plugin's MCP server only until its **required** options are set (see
  CLAUDE.md, "Required plugin options"). The plugin already has two optional options, `nkey_seed`
  and `prefix`, and the server starts while they are empty.
- An unset option reaches the server as an empty string or the literal `${user_config.x}`
  placeholder. `resolveConfig` already treats both as unset, then falls back to
  `~/.agentmesh/agent.json`.

So 0.1.4 drops `required` from both options. With nothing configured anywhere, the server starts
**unenrolled**: it offers only `join`, and its instructions explain the invite flow. Once `join`
succeeds, it loads the new `agent.json`, connects, swaps in the mesh tools and sends
`notifications/tools/list_changed`, all in the same session.

**Not yet verified in a live interactive session:**
- that Claude Code starts the server with both options empty;
- that it refreshes the tool list on `list_changed`.

task-11 (end-to-end) and the first human tryout should confirm both.

**Fallback, already in place.** `node <plugin dir>/dist/server.js join` enrolls from a terminal
and writes `agent.json`. If a Claude Code version still prompts for the options, the command
prints the two values to enter. If the tool list does not refresh, restarting the session picks
up the saved configuration.
