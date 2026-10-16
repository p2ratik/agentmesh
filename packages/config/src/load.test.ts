import { describe, expect, it } from 'vitest';
import { ConfigError, configFromObject } from './load';
import { ConfigIndex } from './lookup';

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
