import { processContext, runCli } from '@agentmesh/cli';

/**
 * `dist/cli.js`: the `agentmesh` CLI shipped inside the plugin, so `/agentmesh:setup`
 * runs it with `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` and the admin installs nothing else.
 * It sets the exit code and lets Node exit on its own: `process.exit` right after a `fetch`
 * aborts Node 24 on Windows (a libuv assertion, exit 127) even when the command succeeded.
 */
runCli(process.argv.slice(2), processContext()).then((code) => {
  process.exitCode = code;
});
