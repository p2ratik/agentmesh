import { runMain } from '@agentmesh/cli';

/**
 * `dist/cli.js`: the `agentmesh` CLI shipped inside the plugin, so `/agentmesh:setup`
 * runs it with `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` and the admin installs nothing else.
 * `runMain` sets the exit code and lets Node exit on its own (see there for why).
 */
void runMain(process.argv.slice(2));
