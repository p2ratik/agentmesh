import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'plugins/*/src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    // Integration tests self-skip unless AGENTMESH_TEST_NATS points at a NATS server.
    testTimeout: 20_000,
  },
});
