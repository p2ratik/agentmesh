import { ConfigIndex } from '@agentmesh/config';
import { describe, expect, it } from 'vitest';
import { testTeamConfig } from '../../../testing/fixtures';
import { areaRecipients } from './recipients';

const index = new ConfigIndex(
  testTeamConfig({
    areas: [
      { id: 'api', owners: ['alice-agent'], skills: ['backend'] },
      // dana-agent joins by invite later; carol-agent shares the area's skill.
      { id: 'ops', owners: ['dana-agent'], skills: ['infra'] },
      { id: 'design', owners: ['erin-agent'], skills: ['figma'] },
    ],
  }).config,
);
const online = (id: string) => id === 'bob-agent';

describe('areaRecipients', () => {
  it('notifies the owners who are on the team', () => {
    expect(areaRecipients(index, 'api', online)).toEqual({
      recipients: ['alice-agent'],
      pending: [],
    });
  });

  it('falls back to agents with the area skills while its owners have not joined', () => {
    expect(areaRecipients(index, 'ops', online)).toEqual({
      recipients: ['carol-agent'],
      pending: ['dana-agent'],
    });
  });

  it('falls back to whoever is online when nobody has the skills either', () => {
    expect(areaRecipients(index, 'design', online)).toEqual({
      recipients: ['bob-agent'],
      pending: ['erin-agent'],
    });
  });

  it('notifies nobody for an unknown area', () => {
    expect(areaRecipients(index, 'nope', online)).toEqual({ recipients: [], pending: [] });
  });
});
