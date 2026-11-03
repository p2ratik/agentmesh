import { defineConfig } from 'tsup';

/**
 * Bundles the plugin and every dependency into dist/server.js, the
 * `agentmesh` CLI into dist/cli.js, the pull-mode prompt hook into
 * dist/hook.js and the mesh window's worktree guard into dist/guard.js (both
 * Node built-ins only, so they start fast), so developer laptops need no
 * `npm install`: Claude Code runs them with plain `node`.
 */
export default defineConfig({
  entry: { server: 'src/main.ts', cli: 'src/cli.ts', hook: 'src/hook.ts', guard: 'src/guard.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  // Keep `node:` specifiers: newer built-ins such as node:sqlite only exist with the prefix.
  removeNodeProtocol: false,
  clean: true,
  splitting: false,
  sourcemap: false,
  noExternal: [/.*/],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
