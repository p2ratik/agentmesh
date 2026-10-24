import { processContext, runCli } from '@agentmesh/cli';

/**
 * `dist/cli.js`: the `agentmesh` CLI shipped inside the plugin, so `/agentmesh:setup`
 * runs it with `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` and the admin installs nothing else.
 */
runCli(process.argv.slice(2), processContext()).then((code) => process.exit(code));
