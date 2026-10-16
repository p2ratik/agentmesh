import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config';
import { parseRemote } from './git';

const missingFile = join(tmpdir(), 'agentmesh-does-not-exist.json');

describe('resolveConfig', () => {
  it('reads plugin user config from the environment', () => {
    const result = resolveConfig(
      {
        AGENTMESH_AGENT_ID: 'alice-agent',
        AGENTMESH_NATS_URL: 'nats://a:4222, nats://b:4222',
        AGENTMESH_PREFIX: 'acme',
      },
      missingFile,
    );
    expect(result).toEqual({
      ok: true,
      config: {
        agentId: 'alice-agent',
        servers: ['nats://a:4222', 'nats://b:4222'],
        prefix: 'acme',
        heartbeatSeconds: 20,
      },
    });
  });

  it('treats unset placeholders as missing and falls back to ~/.agentmesh/agent.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-'));
    const file = join(dir, 'agent.json');
    writeFileSync(
      file,
      JSON.stringify({
        agentId: 'bob-agent',
        natsUrl: 'nats://hub:4222',
        nkeySeed: '/keys/bob.nk',
      }),
    );
    const result = resolveConfig(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder Claude Code may pass through
      { AGENTMESH_AGENT_ID: '${user_config.agent_id}', AGENTMESH_NATS_URL: '' },
      file,
    );
    expect(result.ok && result.config).toMatchObject({
      agentId: 'bob-agent',
      nkeySeed: '/keys/bob.nk',
      prefix: 'mesh',
    });
  });

  it('lists every problem when unconfigured', () => {
    const result = resolveConfig(
      { AGENTMESH_AGENT_ID: 'Bad Id', AGENTMESH_PREFIX: '9x' },
      missingFile,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems).toEqual([
      'agent_id "Bad Id" is not a valid id',
      'nats_url is not set',
      'prefix "9x" is not valid',
    ]);
  });
});

describe('parseRemote', () => {
  it('extracts owner/name from https and ssh remotes', () => {
    expect(parseRemote('https://github.com/acme/api.git')).toBe('acme/api');
    expect(parseRemote('git@github.com:acme/web.git')).toBe('acme/web');
    expect(parseRemote('https://gitlab.example.com/group/repo/')).toBe('group/repo');
  });
});
