import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serverAnswers } from './testing';
import { loadAnswers, markDone, readState, workspacePaths, writeRendered } from './workspace';

const tempWorkspace = () => workspacePaths(mkdtempSync(join(tmpdir(), 'agentmesh-ws-')));

describe('workspacePaths', () => {
  it('lays out config/ and deploy/ under the root', () => {
    const p = workspacePaths(join('ws'));
    expect(p.answers).toBe(join('ws', 'setup-answers.json'));
    expect(p.meshFile).toBe(join('ws', 'config', 'mesh.yaml'));
    expect(p.policyFile).toBe(join('ws', 'config', 'policy', 'team-policy.md'));
    expect(p.envFile).toBe(join('ws', 'deploy', '.env'));
    expect(p.natsConf).toBe(join('ws', 'deploy', 'nats', 'nats.conf'));
    expect(p.claudeSettings).toBe(join('ws', '.claude', 'settings.json'));
    expect(p.claudeMd).toBe(join('ws', 'CLAUDE.md'));
  });
});

describe('setup state', () => {
  it('starts empty', () => {
    expect(readState(tempWorkspace())).toEqual({ version: 1, done: {} });
  });

  it('markDone round-trips', () => {
    const p = tempWorkspace();
    markDone(p, 'render', new Date('2026-10-23T10:00:00Z'));
    markDone(p, 'discord', new Date('2026-10-23T11:00:00Z'));
    expect(readState(p)).toEqual({
      version: 1,
      done: { render: '2026-10-23T10:00:00.000Z', discord: '2026-10-23T11:00:00.000Z' },
    });
  });

  it('rejects a state file that is not ours', () => {
    const p = tempWorkspace();
    writeFileSync(p.state, JSON.stringify({ version: 2, done: {} }));
    expect(() => readState(p)).toThrow(p.state);
  });
});

describe('loadAnswers', () => {
  it('a missing file is not_found', () => {
    expect(() => loadAnswers(tempWorkspace())).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('parses and validates the file', () => {
    const p = tempWorkspace();
    writeFileSync(p.answers, JSON.stringify(serverAnswers()));
    expect(loadAnswers(p).git.integrationBranch).toBe('agents');
  });
});

describe('writeRendered', () => {
  it('creates, leaves alone, reports a difference, replaces only with force', () => {
    const path = join(tempWorkspace().deployDir, 'docker-compose.yml');
    expect(writeRendered(path, 'a\n', false)).toBe('created');
    expect(writeRendered(path, 'a\n', false)).toBe('unchanged');
    expect(writeRendered(path, 'b\n', false)).toBe('differs');
    expect(readFileSync(path, 'utf8')).toBe('a\n');
    expect(writeRendered(path, 'b\n', true)).toBe('replaced');
    expect(readFileSync(path, 'utf8')).toBe('b\n');
  });
});
