import { configFromObject, type LoadedConfig } from '@agentmesh/config';

/**
 * A small, realistic team used across hub tests:
 * - humans alice (admin), bob, carol — each with an agent
 * - area `api` owned by alice-agent and carol-agent, area `web` owned by bob-agent
 * - a Discord bridge allowed to act for humans, and a Hermes ingest service
 */
export function testTeamConfig(overrides: Record<string, unknown> = {}): LoadedConfig {
  return configFromObject({
    version: 1,
    mesh: { name: 'test-mesh', prefix: 'mesh' },
    humans: [
      { id: 'alice', displayName: 'Alice', discordUserId: '100000000000000001', roles: ['admin'] },
      { id: 'bob', displayName: 'Bob', discordUserId: '100000000000000002' },
      { id: 'carol', displayName: 'Carol', discordUserId: '100000000000000003' },
    ],
    agents: [
      { id: 'alice-agent', owner: 'alice', skills: ['backend', 'api'] },
      { id: 'bob-agent', owner: 'bob', skills: ['frontend'] },
      { id: 'carol-agent', owner: 'carol', skills: ['backend', 'infra'] },
    ],
    services: [
      { id: 'discord-bridge', role: 'bridge', canActAsHumans: true },
      { id: 'hermes', role: 'ingest' },
    ],
    areas: [
      {
        id: 'api',
        repos: ['acme/api'],
        paths: ['api/**'],
        owners: ['alice-agent', 'carol-agent'],
        skills: ['backend'],
      },
      {
        id: 'web',
        repos: ['acme/web'],
        paths: ['web/**'],
        owners: ['bob-agent'],
        skills: ['frontend'],
      },
    ],
    ingest: {
      sources: [{ id: 'hermes', auth: { type: 'bearer', token: 'test-token-0123456789abcdef' } }],
    },
    ...overrides,
  });
}
