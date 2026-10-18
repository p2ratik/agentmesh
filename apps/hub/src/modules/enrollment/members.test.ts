import { ConfigIndex } from '@agentmesh/config';
import type { MemberRecord } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { testTeamConfig } from '../../testing/fixtures';
import { withMembers } from './members';

const KEY = (c: string) => `U${c.repeat(55)}`;

const member = (overrides: Partial<MemberRecord> = {}): MemberRecord => ({
  humanId: 'dana',
  agentId: 'dana-agent',
  displayName: 'Dana',
  discordUserId: '200000000000000001',
  roles: ['admin'],
  skills: ['backend'],
  nkey: KEY('D'),
  status: 'active',
  invitedBy: 'alice',
  joinedAt: '2026-10-16T09:00:00.000Z',
  removedAt: null,
  ...overrides,
});

describe('withMembers', () => {
  const yaml = testTeamConfig({
    hub: { authCallout: { sysNkey: KEY('S') } },
    agents: [{ id: 'alice-agent', owner: 'alice', nkey: KEY('A') }],
    areas: [],
  }).config;

  it('adds each active member as a human and their agent', () => {
    const { config, shadowed } = withMembers(yaml, [member()]);
    const index = new ConfigIndex(config);
    expect(shadowed).toEqual([]);
    expect(index.agent('dana-agent')).toMatchObject({ owner: 'dana', nkey: KEY('D') });
    expect(index.humanByDiscordId('200000000000000001')?.id).toBe('dana');
    expect(index.hasRole('dana', 'admin')).toBe(true);
    expect(index.primaryAgentOf('dana')?.id).toBe('dana-agent');
    // mesh.yaml itself is untouched
    expect(yaml.agents.map((a) => a.id)).toEqual(['alice-agent']);
  });

  it('never merges revoked members', () => {
    const { config } = withMembers(yaml, [member({ status: 'revoked' })]);
    expect(new ConfigIndex(config).kindOf('dana-agent')).toBeUndefined();
  });

  it.each<[string, Partial<MemberRecord>]>([
    ['a human id', { humanId: 'bob', agentId: 'bob-2' }],
    ['an agent id', { agentId: 'alice-agent' }],
    ['a service id', { agentId: 'discord-bridge' }],
    ['the hub id', { humanId: 'hub' }],
    ['a Discord id', { discordUserId: '100000000000000002' }],
    ['an agent key', { nkey: KEY('A') }],
    ["the hub's system-account key", { nkey: KEY('S') }],
  ])('lets mesh.yaml win when a member reuses %s', (_label, overrides) => {
    const { config, shadowed } = withMembers(yaml, [member(overrides)]);
    const index = new ConfigIndex(config);
    expect(shadowed).toEqual([overrides.humanId ?? 'dana']);
    expect(index.agent('dana-agent')).toBeUndefined();
    expect(index.humanByDiscordId('100000000000000002')?.id).toBe('bob');
    expect(index.agent('alice-agent')?.owner).toBe('alice');
  });
});
