import { describe, expect, it } from 'vitest';
import { ConfigError, configFromObject } from './load';
import { ConfigIndex } from './lookup';
import { pendingAreaOwners } from './validate';

const minimal = {
  version: 1,
  mesh: { name: 'acme' },
  humans: [{ id: 'alice', displayName: 'Alice', roles: ['admin'] }],
  agents: [{ id: 'alice-agent', owner: 'alice' }],
};

describe('configFromObject', () => {
  it('applies defaults and built-ins', () => {
    const { config } = configFromObject(minimal);
    expect(config.mesh.prefix).toBe('mesh');
    expect(config.git.integrationBranch).toBe('agents');
    expect(config.limits.maxThreadDepth).toBe(3);
    expect(config.workflows.map((w) => w.id)).toEqual(['feature', 'review']);
    expect(config.planning.templates.map((t) => t.id)).toEqual(['standard']);
    expect(config.discord.channels.planning?.type).toBe('forum');
  });

  it('normalizes workflow effect references', () => {
    const { config } = configFromObject(minimal);
    const feature = config.workflows.find((w) => w.id === 'feature');
    expect(feature?.states.backlog?.onEnter).toEqual([{ name: 'auto_assign', params: {} }]);
  });

  it('lets a team override a built-in workflow by id', () => {
    const custom = {
      id: 'feature',
      initial: 'todo',
      states: { todo: {}, done: { terminal: true } },
      transitions: [{ action: 'finish', from: ['todo'], to: 'done', by: ['assignee'] }],
    };
    const { config } = configFromObject({ ...minimal, workflows: [custom] });
    expect(config.workflows.find((w) => w.id === 'feature')?.initial).toBe('todo');
  });

  it('reports every broken reference with its path', () => {
    const broken = {
      ...minimal,
      agents: [{ id: 'ghost-agent', owner: 'nobody' }],
      areas: [{ id: 'api', owners: ['alice'] }],
    };
    try {
      configFromObject(broken);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const paths = (error as ConfigError).issues.map((i) => i.path);
      expect(paths).toContain('agents[0].owner');
      expect(paths).toContain('areas[0].owners');
    }
  });

  it('accepts an area owner who will join by invite, and lists it as pending', () => {
    const tree = { ...minimal, areas: [{ id: 'web', owners: ['alice-agent', 'dana-agent'] }] };
    const { config } = configFromObject(tree);
    expect(pendingAreaOwners(config)).toEqual(['dana-agent']);
  });

  it('still refuses a human, a service or the hub as an area owner', () => {
    const tree = {
      ...minimal,
      services: [{ id: 'ci', role: 'ingest' }],
      areas: [
        { id: 'web', owners: ['alice'] },
        { id: 'ops', owners: ['ci'] },
        { id: 'core', owners: ['hub'] },
      ],
    };
    try {
      configFromObject(tree);
      expect.unreachable();
    } catch (error) {
      const messages = (error as ConfigError).issues.map((i) => `${i.path}: ${i.message}`);
      expect(messages).toContain('areas[0].owners: "alice" is a human, not an agent');
      expect(messages).toContain('areas[1].owners: "ci" is a service, not an agent');
      expect(messages).toContain('areas[2].owners: "hub" is the hub');
    }
  });

  it('requires the discord service to be a bridge that may act for humans', () => {
    const tree = {
      ...minimal,
      services: [{ id: 'discord-bridge', role: 'custom' }],
      discord: { enabled: true, token: 't', applicationId: '1', guildId: '2' },
    };
    try {
      configFromObject(tree);
      expect.unreachable();
    } catch (error) {
      const messages = (error as ConfigError).issues.map((i) => i.message);
      expect(messages).toContain('service "discord-bridge" needs role: bridge');
      expect(messages).toContain('service "discord-bridge" needs canActAsHumans: true');
    }
  });

  it('requires discord settings when discord is enabled', () => {
    expect(() => configFromObject({ ...minimal, discord: { enabled: true } })).toThrow(
      /discord.token/,
    );
  });
});

describe('ConfigIndex', () => {
  it('resolves kinds, owners and display names', () => {
    const index = new ConfigIndex(configFromObject(minimal).config);
    expect(index.kindOf('alice')).toBe('human');
    expect(index.kindOf('alice-agent')).toBe('agent');
    expect(index.displayName('alice-agent')).toBe("Alice's agent");
    expect(index.primaryAgentOf('alice')?.id).toBe('alice-agent');
  });
});
