import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WindowPolicy } from '@agentmesh/common/window';
import { afterEach, describe, expect, it } from 'vitest';
import { hookAgentId, parseSavedAgent, resolveAgentId } from './agent-id';
import { resolveConfig } from './config';
import { windowStartState } from './window/start-state';

// What Claude Code leaves in an unset option; built so it is not mistaken for a template string.
const placeholder = (name: string) => ['$', '{user_config.', name, '}'].join('');

describe('resolveAgentId', () => {
  const saved = { agentId: 'alice-agent', natsUrl: 'tls://hub:4222' };

  it('takes the option, trimmed, over the file', () => {
    expect(resolveAgentId({ agentId: '  alice-agent  ' }, null)).toBe('alice-agent');
    expect(resolveAgentId({ agentId: ' bob-agent ' }, { agentId: 'alice-agent' })).toBe(
      'bob-agent',
    );
  });

  it('falls back to the file when the option is empty or an unexpanded placeholder', () => {
    expect(resolveAgentId({}, saved)).toBe('alice-agent');
    expect(resolveAgentId({ agentId: '', natsUrl: ' ' }, saved)).toBe('alice-agent');
    expect(resolveAgentId({ agentId: placeholder('agent_id') }, saved)).toBe('alice-agent');
  });

  it("ignores a file for another hub, like the server's fileApplies", () => {
    expect(resolveAgentId({ natsUrl: 'tls://other:4222' }, saved)).toBeNull();
    expect(resolveAgentId({ natsUrl: ' tls://hub:4222 ' }, saved)).toBe('alice-agent');
  });

  it('is null with nothing set', () => {
    expect(resolveAgentId({}, null)).toBeNull();
    expect(resolveAgentId({}, {})).toBeNull();
  });

  it('agrees with resolveConfig on the same inputs', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'am-agentid-')), 'agent.json');
    writeFileSync(file, JSON.stringify({ ...saved, nkeySeed: 'S' }));
    const cases = [
      {},
      { AGENTMESH_AGENT_ID: ' bob-agent ', AGENTMESH_NATS_URL: 'tls://hub:4222' },
      { AGENTMESH_NATS_URL: 'tls://other:4222' },
      { AGENTMESH_AGENT_ID: placeholder('agent_id'), AGENTMESH_NATS_URL: placeholder('x') },
    ];
    for (const env of cases) {
      const r = resolveConfig(env, file);
      const server = r.ok ? r.config.agentId : null;
      const hook = resolveAgentId(
        { agentId: env.AGENTMESH_AGENT_ID, natsUrl: env.AGENTMESH_NATS_URL },
        saved,
      );
      expect(hook).toBe(server);
    }
  });
});

describe('parseSavedAgent', () => {
  it('accepts the shape the server accepts and refuses the rest', () => {
    expect(parseSavedAgent({ agentId: 'a', extra: 1 })).toEqual({ agentId: 'a' });
    expect(parseSavedAgent({})).toEqual({});
    for (const bad of [null, [], 'x', 5, { agentId: 5 }, { natsUrl: null }, { prefix: {} }]) {
      expect(parseSavedAgent(bad)).toBeNull();
    }
  });
});

describe('hookAgentId', () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const withFile = (text: string) => {
    home = mkdtempSync(join(tmpdir(), 'am-agentid-home-'));
    mkdirSync(join(home, '.agentmesh'));
    writeFileSync(join(home, '.agentmesh', 'agent.json'), text);
  };

  it('reads agent.json when the options are empty, and ignores one of the wrong shape', () => {
    withFile('{"agentId":"alice-agent"}');
    expect(hookAgentId({}, home)).toBe('alice-agent');
    expect(hookAgentId({ CLAUDE_PLUGIN_OPTION_AGENT_ID: placeholder('agent_id') }, home)).toBe(
      'alice-agent',
    );
    expect(hookAgentId({ CLAUDE_PLUGIN_OPTION_NATS_URL: 'tls://x:4222' }, home)).toBe(
      'alice-agent',
    );
    withFile('{"agentId":5}');
    expect(hookAgentId({}, home)).toBeNull();
    withFile('{broken');
    expect(hookAgentId({}, home)).toBeNull();
  });
});

describe('windowStartState', () => {
  const policy: WindowPolicy = {
    version: 1,
    agentId: 'alice-agent',
    token: 'a'.repeat(32),
    ownBranchPrefix: null,
    integrationBranch: 'agents',
    testCommands: [],
  };

  it('reads the policy file once, marked or not, and agrees with activate on set up', () => {
    for (const env of [{}, { AGENTMESH_MESH_WINDOW: policy.token }]) {
      let reads = 0;
      const readPolicy = () => {
        reads++;
        return policy;
      };
      const s = windowStartState(env, 'alice-agent', '/h', 'linux', readPolicy);
      expect(reads).toBe(1);
      expect(s.setUp).toBe(true);
      expect(s.policy).toEqual(env.AGENTMESH_MESH_WINDOW ? policy : null);
      expect(windowStartState(env, 'bob-agent', '/h', 'linux', readPolicy).setUp).toBe(false);
      expect(windowStartState(env, null, '/h', 'linux', readPolicy).setUp).toBe(false);
      expect(windowStartState(env, 'alice-agent', '/h', 'linux', () => null).setUp).toBe(false);
    }
  });
});
