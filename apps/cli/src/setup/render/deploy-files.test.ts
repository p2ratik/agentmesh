import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseAnswers } from '../answers';
import { serverAnswers, trialAnswers } from '../testing';
import { renderClaudeSettings, renderCompose, renderEnv } from './deploy-files';

const env = (hosting = parseAnswers(serverAnswers()).hosting) =>
  renderEnv({ hosting, version: '9.9.9', registry: 'ghcr.io/acme' });

const settingLines = (text: string) => text.split('\n').filter((l) => l && !l.startsWith('#'));

describe('renderCompose', () => {
  it('pulls the published images instead of building', () => {
    const compose = renderCompose();
    expect(compose).not.toContain('build:');
    expect(compose).toContain(
      `image: \${AGENTMESH_IMAGE_REGISTRY}/agentmesh-hub:\${AGENTMESH_VERSION}`,
    );
    expect(compose).toContain(
      `image: \${AGENTMESH_IMAGE_REGISTRY}/agentmesh-discord-bridge:\${AGENTMESH_VERSION}`,
    );
  });

  it('keeps the services, volumes, ports and the discord profile', () => {
    const { services, volumes } = parse(renderCompose());
    expect(Object.keys(services)).toEqual(['nats', 'hub', 'discord-bridge']);
    expect(services.nats.ports).toEqual([`\${NATS_BIND:-127.0.0.1}:4222:4222`]);
    expect(services.nats.networks.default.aliases).toEqual([`\${NATS_PUBLIC_HOST:-nats}`]);
    expect(services.hub.ports).toEqual([`\${HUB_HTTP_BIND:-127.0.0.1}:8787:8787`]);
    expect(services.hub.environment.AGENTMESH_SECRETS_DIR).toBe('/secrets');
    expect(services['discord-bridge'].profiles).toEqual(['discord']);
    expect(services['discord-bridge'].environment.AGENTMESH_NKEY_SEED).toBe(
      '/secrets/discord-bridge.nk',
    );
    expect(Object.keys(volumes)).toEqual(['nats-data', 'hub-data']);
  });

  it('mounts every seed into the hub but only its own into the bridge', () => {
    const compose = renderCompose();
    const { services } = parse(compose);
    expect(services.hub.volumes).toContain('./secrets:/secrets:ro');
    expect(services['discord-bridge'].volumes).toEqual([
      `\${AGENTMESH_CONFIG_DIR:-../config}:/config:ro`,
      './secrets/discord-bridge.nk:/secrets/discord-bridge.nk:ro',
    ]);
    const bridge = compose.slice(compose.indexOf('  discord-bridge:'));
    expect(bridge).not.toContain('./secrets:/secrets');
  });
});

describe('renderEnv', () => {
  it('a server publishes NATS on its public host', () => {
    const lines = env().split('\n');
    expect(lines).toContain('NATS_PUBLIC_HOST=mesh.acme.dev');
    expect(lines).toContain('NATS_BIND=0.0.0.0');
    expect(lines).toContain('AGENTMESH_IMAGE_REGISTRY=ghcr.io/acme');
    expect(lines).toContain('AGENTMESH_VERSION=9.9.9');
    expect(lines).toContain('DISCORD_BOT_TOKEN=');
  });

  it('a trial keeps NATS on this machine', () => {
    const lines = env(parseAnswers(trialAnswers()).hosting).split('\n');
    expect(lines).toContain('NATS_BIND=127.0.0.1');
    expect(lines).toContain('NATS_PUBLIC_HOST=');
  });

  it('every setting has its comment on the line above and nothing after the value', () => {
    const text = env();
    const lines = text.split('\n');
    expect(settingLines(text)).toHaveLength(10);
    lines.forEach((line, i) => {
      if (!line || line.startsWith('#')) return;
      expect(line).toMatch(/^[A-Z_]+=[^\s#]*$/);
      expect(lines[i - 1]).toMatch(/^# /);
    });
  });
});

describe('renderClaudeSettings', () => {
  it('denies reading .env and the seeds', () => {
    expect(JSON.parse(renderClaudeSettings())).toEqual({
      permissions: { deny: ['Read(./deploy/.env)', 'Read(./deploy/secrets/**)'] },
    });
  });
});
