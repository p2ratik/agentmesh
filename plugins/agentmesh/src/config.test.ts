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

  it("keeps agent.json's prefix over the option Claude Code stored by default", () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-'));
    const file = join(dir, 'agent.json');
    writeFileSync(
      file,
      JSON.stringify({ agentId: 'dana-agent', natsUrl: 'tls://hub:4222', prefix: 'acme' }),
    );
    const result = resolveConfig({ AGENTMESH_PREFIX: 'mesh' }, file);
    expect(result.ok && result.config.prefix).toBe('acme');
    expect(result.ok && result.warnings).toEqual([
      'ignoring the prefix option "mesh": ~/.agentmesh/agent.json sets "acme"',
    ]);
    const sameHub = resolveConfig(
      { AGENTMESH_NATS_URL: 'tls://hub:4222', AGENTMESH_PREFIX: 'mesh' },
      file,
    );
    expect(sameHub.ok && sameHub.config.prefix).toBe('acme');
  });

  describe('ignores an agent.json written for another agent or hub', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-'));
    const file = join(dir, 'agent.json');
    writeFileSync(
      file,
      JSON.stringify({
        agentId: 'dana-agent',
        natsUrl: 'tls://hub-a:4222',
        nkeySeed: '/keys/dana.nk',
        prefix: 'acme',
      }),
    );

    it('another hub with an empty or placeholder prefix gets mesh and no seed', () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder Claude Code may pass through
      for (const AGENTMESH_PREFIX of ['', '${user_config.prefix}']) {
        const result = resolveConfig(
          {
            AGENTMESH_AGENT_ID: 'erin-agent',
            AGENTMESH_NATS_URL: 'tls://hub-b:4222',
            AGENTMESH_PREFIX,
          },
          file,
        );
        expect(result.ok && result.config).toEqual({
          agentId: 'erin-agent',
          servers: ['tls://hub-b:4222'],
          prefix: 'mesh',
          heartbeatSeconds: 20,
        });
      }
    });

    it('the same hub with another agent id keeps the prefix option', () => {
      const result = resolveConfig(
        {
          AGENTMESH_AGENT_ID: 'e2e-agent',
          AGENTMESH_NATS_URL: 'tls://hub-a:4222',
          AGENTMESH_PREFIX: 'e2e',
        },
        file,
      );
      expect(result.ok && result.config.prefix).toBe('e2e');
      expect(result.ok && result.config.nkeySeed).toBeUndefined();
      expect(result.ok && result.warnings).toBeUndefined();
    });
  });

  // `setup admin` on a laptop already enrolled through the options: they win, so its message
  // tells the admin to clear agent_id, nats_url and nkey_seed in /plugin.
  it('options for another agent keep it, over the agent.json setup admin wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-'));
    const file = join(dir, 'agent.json');
    writeFileSync(
      file,
      JSON.stringify({
        agentId: 'riya-agent',
        natsUrl: 'tls://mesh.acme.dev:4222',
        nkeySeed: '/home/riya/.agentmesh/acme-riya-agent.nk',
        prefix: 'mesh',
      }),
    );
    const result = resolveConfig(
      {
        AGENTMESH_AGENT_ID: 'sam-agent',
        AGENTMESH_NATS_URL: 'tls://other-mesh.example.com:4222',
        AGENTMESH_NKEY_SEED: '/home/riya/.agentmesh/sam-agent.nk',
      },
      file,
    );
    expect(result).toEqual({
      ok: true,
      config: {
        agentId: 'sam-agent',
        servers: ['tls://other-mesh.example.com:4222'],
        nkeySeed: '/home/riya/.agentmesh/sam-agent.nk',
        prefix: 'mesh',
        heartbeatSeconds: 20,
      },
    });
    // With the options cleared, the same file connects the admin's agent.
    const cleared = resolveConfig({}, file);
    expect(cleared.ok && cleared.config).toMatchObject({
      agentId: 'riya-agent',
      servers: ['tls://mesh.acme.dev:4222'],
      nkeySeed: '/home/riya/.agentmesh/acme-riya-agent.nk',
    });
  });

  it('still fills the seed from a hand-written agent.json that holds only the seed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-'));
    const file = join(dir, 'agent.json');
    writeFileSync(file, JSON.stringify({ nkeySeed: '/keys/frank.nk' }));
    const result = resolveConfig(
      { AGENTMESH_AGENT_ID: 'frank-agent', AGENTMESH_NATS_URL: 'tls://hub:4222' },
      file,
    );
    expect(result.ok && result.config.nkeySeed).toBe('/keys/frank.nk');
  });

  it('keeps the log file for an unenrolled plugin', () => {
    const result = resolveConfig({ AGENTMESH_LOG_FILE: '/tmp/mesh.log' }, missingFile);
    expect(result).toMatchObject({ ok: false, unenrolled: true, logFile: '/tmp/mesh.log' });
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
