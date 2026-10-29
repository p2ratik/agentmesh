import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../../context';
import { runCli } from '../../main';
import { parseAnswers } from '../../setup/answers';
import { readEnvFile } from '../../setup/env-file';
import { renderStatus } from '../../setup/render/status';
import { type AnswersInput, serverAnswers, trialAnswers } from '../../setup/testing';
import { markDone, readState, workspacePaths } from '../../setup/workspace';

/** A workspace holding only `setup-answers.json`, and the CLI run on it. */
function workspace(answers: AnswersInput) {
  const cwd = mkdtempSync(join(tmpdir(), 'agentmesh-setup-status-'));
  const out: string[] = [];
  const ctx: CliContext = {
    cwd,
    env: {},
    homeDir: join(cwd, 'home'),
    stdout: (t) => out.push(t),
    stderr: () => {},
  };
  const p = workspacePaths(join(cwd, 'ws'));
  mkdirSync(p.root);
  writeFileSync(p.answers, JSON.stringify(answers));
  const run = (...argv: string[]) => runCli([...argv, '--dir', p.root], ctx);
  const next = async () => {
    expect(await run('setup', 'status')).toBe(0);
    return out.at(-1)?.split('\n').at(-1);
  };
  return { p, run, next };
}

describe('setup status', () => {
  it('confirms the answers before the first render, then follows the steps', async () => {
    const w = workspace(trialAnswers());
    expect(await w.next()).toBe(
      'Next: confirm the answers (setup render --dry-run), then run setup render',
    );
    expect(await w.run('setup', 'render')).toBe(0);
    expect(await w.next()).toBe('Next: run setup discord');
  });

  it('follows the steps, skipping host on a trial', () => {
    const at = '2026-10-23T10:00:00.000Z';
    const server = parseAnswers(serverAnswers());
    const trial = parseAnswers(trialAnswers());
    const done = (...steps: string[]) => ({
      version: 1 as const,
      done: Object.fromEntries(steps.map((s) => [s, at])),
    });
    expect(renderStatus(done('render', 'discord'), server)).toMatch(/Next: run setup host$/);
    expect(renderStatus(done('render', 'discord'), trial)).toMatch(/Next: run setup deploy$/);
    // Activation first: the proof's round trip needs an active session.
    expect(renderStatus(done('render', 'discord', 'deploy', 'admin'), trial)).toMatch(
      /Next: run \/agentmesh:activate, then the proof \(doctor, peers, hello\), then setup invites$/,
    );
  });

  it('a finished trial going real needs setup host, deploy and admin again', async () => {
    const w = workspace(trialAnswers());
    expect(await w.run('setup', 'render')).toBe(0);
    expect(await w.run('setup', 'host')).toBe(0);
    for (const step of ['discord', 'deploy', 'admin'] as const) markDone(w.p, step, new Date());
    expect(readState(w.p).done.host).toBeUndefined();

    writeFileSync(w.p.answers, JSON.stringify(serverAnswers()));
    expect(await w.next()).toBe(
      'Next: confirm the answers (setup render --dry-run), then run setup render --force ' +
        '(the hosting changed)',
    );
    expect(await w.run('setup', 'render', '--force')).toBe(0);
    expect(Object.keys(readState(w.p).done).sort()).toEqual(['discord', 'render']);
    expect(readState(w.p).mode).toBe('server');
    expect(await w.next()).toBe('Next: run setup host');
    const env = readEnvFile(w.p.envFile);
    expect(env.get('NATS_BIND')).toBe('0.0.0.0');
    expect(env.get('NATS_PUBLIC_HOST')).toBe('mesh.acme.dev');

    // And back: a server workspace switched to a trial forgets its server steps too. (Without
    // the test agent, whose seed from the first trial is still there and is never replaced.)
    for (const step of ['host', 'deploy', 'admin'] as const) markDone(w.p, step, new Date());
    writeFileSync(w.p.answers, JSON.stringify({ ...trialAnswers(), hosting: { mode: 'trial' } }));
    expect(await w.run('setup', 'render', '--force')).toBe(0);
    expect(Object.keys(readState(w.p).done).sort()).toEqual(['discord', 'render']);
    expect(readEnvFile(w.p.envFile).get('NATS_BIND')).toBe('127.0.0.1');
    expect(await w.next()).toBe('Next: run setup deploy');
  });

  it('a forced render for the same hosting keeps the steps done', async () => {
    const w = workspace(serverAnswers());
    expect(await w.run('setup', 'render')).toBe(0);
    for (const step of ['discord', 'host', 'deploy'] as const) markDone(w.p, step, new Date());
    expect(await w.run('setup', 'render', '--force')).toBe(0);
    expect(Object.keys(readState(w.p).done).sort()).toEqual([
      'deploy',
      'discord',
      'host',
      'render',
    ]);
  });
});
