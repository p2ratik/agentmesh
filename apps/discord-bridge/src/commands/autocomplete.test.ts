import { ConfigIndex, configFromObject } from '@agentmesh/config';
import type { OpenInvite } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { autocompleteFor } from './autocomplete';

const index = new ConfigIndex(
  configFromObject({
    version: 1,
    mesh: { name: 'acme' },
    humans: [
      { id: 'alice', displayName: 'Alice', discordUserId: '100000000000000001', roles: ['admin'] },
      { id: 'bob', displayName: 'Bob', discordUserId: '100000000000000002' },
    ],
    agents: [{ id: 'bob-agent', owner: 'bob' }],
  }).config,
);
const invite: OpenInvite = {
  inviteId: 'inv-erin',
  humanId: 'erin',
  agentId: 'erin-agent',
  displayName: 'Erin',
  discordUserId: '100000000000000010',
  invitedBy: 'alice',
  expiresAt: '2026-10-20T09:00:00.000Z',
};
const ALICE = '100000000000000001';
const BOB = '100000000000000002';
const STRANGER = '100000000000000099';

const values = (
  discordUserId: string,
  command: string,
  subcommand: string | null,
  option: string,
) =>
  autocompleteFor(
    index,
    { discordUserId, command, subcommand, option, typed: '' },
    { members: [], invites: [invite] },
  ).map((c) => c.value);

describe('autocompleteFor', () => {
  it('offers nothing to someone who is not a member', () => {
    expect(values(STRANGER, 'mesh', 'uninvite', 'person')).toEqual([]);
    expect(values(STRANGER, 'ask', null, 'agent')).toEqual([]);
  });

  it('offers nothing on admin-only subcommands to a member who is not an admin', () => {
    expect(values(BOB, 'mesh', 'uninvite', 'person')).toEqual([]);
    expect(values(BOB, 'mesh', 'remove', 'person')).toEqual([]);
    expect(values(BOB, 'ask', null, 'agent')).toEqual(['bob-agent']);
  });

  it('offers pending invitees to an admin', () => {
    expect(values(ALICE, 'mesh', 'uninvite', 'person')).toEqual(['erin']);
  });
});
