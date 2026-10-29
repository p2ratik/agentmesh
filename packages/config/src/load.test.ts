import { describe, expect, it } from 'vitest';
import { ConfigError, configFromObject } from './load';
import { ConfigIndex } from './lookup';
import { pendingInvitees } from './validate';

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

  it('ownershipGraceMinutes defaults to 120', () => {
    expect(configFromObject(minimal).config.presence.ownershipGraceMinutes).toBe(120);
  });

  // Removed with per-session delivery; existing mesh.yaml files that still set it must load.
  it('ignores the retired limits.deliveryRetentionDays', () => {
    const { config } = configFromObject({ ...minimal, limits: { deliveryRetentionDays: 14 } });
    expect(config.limits).not.toHaveProperty('deliveryRetentionDays');
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
    expect(pendingInvitees(config)).toEqual(['dana-agent']);
  });

  it('accepts reviewers, a facilitator and notify targets who will join by invite', () => {
    const notify = { to: ['alice-agent', 'frank'], text: 'CI failed' };
    const { config } = configFromObject({
      ...minimal,
      review: { humanReviewers: ['dana'] },
      planning: { facilitator: 'erin-agent' },
      rules: [{ id: 'ci', match: { type: 'ci.failed' }, actions: [{ notify }] }],
    });
    expect(pendingInvitees(config)).toEqual(['dana', 'erin-agent', 'frank']);
  });

  it('still refuses the wrong kind of participant as reviewer, facilitator, notify target or rule assignee', () => {
    const tree = {
      ...minimal,
      services: [{ id: 'ci', role: 'ingest' }],
      review: { humanReviewers: ['alice-agent'] },
      planning: { facilitator: 'alice' },
      rules: [
        {
          id: 'ci',
          match: { type: 'x' },
          actions: [
            { notify: { to: ['ci'], text: 'x' } },
            { create_task: { title: 'x', assignee: 'alice' } },
          ],
        },
      ],
    };
    try {
      configFromObject(tree);
      expect.unreachable();
    } catch (error) {
      const messages = (error as ConfigError).issues.map((i) => `${i.path}: ${i.message}`);
      expect(messages).toContain('review.humanReviewers: "alice-agent" is an agent, not a human');
      expect(messages).toContain('planning.facilitator: "alice" is a human, not an agent');
      expect(messages).toContain(
        'rules[0].actions[0].notify.to: "ci" is a service, not an agent or a human',
      );
      expect(messages).toContain(
        'rules[0].actions[1].create_task.assignee: "alice" is a human, not an agent',
      );
    }
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
