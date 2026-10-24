import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@agentmesh/config';
import { describe, expect, it } from 'vitest';
import { findExamplesDir } from '../../lib/repo-paths';
import { parseAnswers } from '../answers';
import { type AnswersInput, serverAnswers, trialAnswers } from '../testing';
import { renderMeshYaml } from './mesh-yaml';
import { renderPolicy } from './policy';
import { renderAnswersSummary } from './summary';

const DISCORD_ENV = { DISCORD_BOT_TOKEN: 't', DISCORD_APP_ID: '1', DISCORD_GUILD_ID: '2' };

/** Renders the answers into a temp config dir and loads it like the hub does. */
function load(raw: AnswersInput) {
  const answers = parseAnswers(raw);
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-setup-'));
  mkdirSync(join(dir, 'policy'));
  writeFileSync(join(dir, 'mesh.yaml'), renderMeshYaml(answers));
  writeFileSync(join(dir, 'policy', 'team-policy.md'), renderPolicy(answers).text);
  return loadConfig(dir, { env: DISCORD_ENV });
}

describe('renderMeshYaml', () => {
  it('points edits at setup deploy: validate cannot read deploy/.env', () => {
    const text = renderMeshYaml(parseAnswers(serverAnswers()));
    expect(text).not.toContain('agentmesh validate');
    expect(text).toContain('`agentmesh setup deploy`');
  });

  it('server answers load cleanly', () => {
    const { config, policyText } = load(serverAnswers());
    expect(config.enrollment.natsUrl).toBe('tls://mesh.acme.dev:4222');
    expect(config.nats.servers).toEqual(['tls://mesh.acme.dev:4222']);
    expect(config.ingest.sources).toEqual([]);
    expect(config.services.map((s) => s.id)).toEqual(['discord-bridge']);
    expect(config.agents).toMatchObject([
      {
        id: 'riya-agent',
        owner: 'riya',
        displayName: "Riya's Claude",
        avatarUrl: 'https://github.com/riya-gh.png',
        skills: ['backend', 'api'],
      },
    ]);
    expect(config.planning.requireApproval).toBe(true);
    expect(config.discord).toMatchObject({ enabled: true, token: 't', guildId: '2' });
    expect(policyText).toContain('## About Acme');
  });

  it('area owners become agents', () => {
    const { config } = load(serverAnswers());
    expect(config.areas[0]?.owners).toEqual(['dana-agent']);
  });

  it('trial answers load cleanly', () => {
    const { config } = load(trialAnswers());
    expect(config.enrollment.natsUrl).toBeUndefined();
    expect(config.nats.servers[0]).toBe('nats://127.0.0.1:4222');
    expect(config.agents.map((a) => a.id)).toEqual(['riya-agent', 'riya-test-agent']);
    expect(config.agents[1]?.displayName).toBe("Riya's test Claude");
  });

  it('gives the test agent its own skills, not a YAML alias of the admin agent', () => {
    const text = renderMeshYaml(parseAnswers(trialAnswers()));
    expect(text).not.toMatch(/ [&*]a\d+$/m);
    const { config } = load(trialAnswers());
    expect(config.agents[1]?.skills).toEqual(['backend', 'api']);
  });

  it('the admin is an admin', () => {
    const raw = serverAnswers();
    raw.admin = { ...raw.admin, roles: ['admin', 'backend lead'] };
    const { config } = load(raw);
    expect(config.humans).toMatchObject([
      { id: 'riya', displayName: 'Riya', roles: ['admin', 'backend lead'] },
    ]);
    expect(config.humans[0]?.roles[0]).toBe('admin');
  });
});

describe('renderPolicy', () => {
  it('lists the people, the decisions and the example working rules', () => {
    const { text, warnings } = renderPolicy(parseAnswers(serverAnswers()));
    expect(warnings).toEqual([]);
    expect(text).toContain('Repos: acme/api, acme/web');
    expect(text).toContain('- Riya (riya-agent): admin, backend lead');
    expect(text).toContain('- Dana (dana-agent): security');
    expect(text).toContain('/plan approve');
    const example = readFileSync(join(findExamplesDir(), 'policy', 'team-policy.md'), 'utf8');
    const rules = example.replace(/^##[^\n]*\n+/, '').trim();
    expect(text).toContain(`## Working rules\n\n${rules}`);
  });

  it('names the branches from the answers', () => {
    const raw = serverAnswers();
    raw.git = { integrationBranch: 'develop', protectedBranches: ['main', 'release'] };
    const { text } = renderPolicy(parseAnswers(raw));
    expect(text).toContain('merged into `develop`');
    expect(text).toContain('Humans promote `develop` → `main`, `release`');
    expect(text).toContain('Never push to `main`, `release` yourself');
    expect(text).not.toContain('`agents`');
  });

  it('long overview warns', () => {
    const raw = serverAnswers();
    raw.team = { ...raw.team, overview: 'x'.repeat(1200) };
    const { warnings } = renderPolicy(parseAnswers(raw));
    expect(warnings).toHaveLength(1);
  });
});

describe('renderAnswersSummary', () => {
  it('lists people, areas, hosting and decisions', () => {
    const summary = renderAnswersSummary(parseAnswers(serverAnswers()));
    expect(summary).toContain('  Riya (riya): roles admin, backend lead; skills backend, api');
    expect(summary).toContain('  security: Auth, secrets and permissions (owners dana)');
    expect(summary).toContain('server mesh.acme.dev (ssh deploy@mesh.acme.dev');
    expect(summary).toContain('Riya (riya) has the final say; plans wait for /plan approve');
  });

  it('fits a big team in 25 lines', () => {
    const raw = serverAnswers();
    raw.people = [
      ...(raw.people ?? []),
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `p${i}`,
        name: `P${i}`,
        discordUsername: `p${i}`,
      })),
    ];
    const summary = renderAnswersSummary(parseAnswers(raw));
    expect(summary.split('\n').length).toBeLessThanOrEqual(25);
    expect(summary).toContain('P29 (p29)');
  });
});
