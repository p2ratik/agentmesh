import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  // Keep `node:` specifiers: newer built-ins such as node:sqlite only exist with the prefix.
  removeNodeProtocol: false,
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript sources, so bundle them in.
  noExternal: [/^@agentmesh\//],
  // Bundled CommonJS dependencies (e.g. nkeys) call require(); give the ESM bundle one.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
});
