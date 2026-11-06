import { describe, expect, it } from 'vitest';
import { configFromObject } from './load';
import { configWarnings } from './validate';

const withServices = (services: object[]) =>
  configFromObject({
    version: 1,
    mesh: { name: 'x' },
    humans: [{ id: 'alice', displayName: 'Alice' }],
    services,
  }).config;

describe('configWarnings', () => {
  it('warns when a service other than the Discord bridge can act as humans', () => {
    const bridge = { id: 'discord-bridge', role: 'bridge', canActAsHumans: true };
    const hermes = { id: 'hermes', role: 'ingest', canActAsHumans: true };
    const issues = configWarnings(withServices([bridge, hermes]));
    expect(issues).toEqual([
      {
        path: 'services[1].canActAsHumans',
        message:
          'service "hermes" can act as any human, so it could send owner-marked commands to every agent; only the Discord bridge (discord.serviceId) should',
      },
    ]);
    expect(configWarnings(withServices([bridge]))).toEqual([]);
  });
});
