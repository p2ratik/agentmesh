// Shared by the setup deploy and upgrade tests: a rendered workspace with a fake `run`.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { CliContext } from '../../context';
import { runCli } from '../../main';
import { updateEnvFile } from '../../setup/env-file';
import type { AnswersInput } from '../../setup/testing';
import { markDone, type StepName, workspacePaths } from '../../setup/workspace';

export const TOKEN = 'tok-SECRET-123';

interface Call {
  cmd: string;
  args: readonly string[];
  cwd?: string;
}

/**
 * A rendered workspace in a folder whose name has a space, with the Discord values in .env
 * and the `done` steps recorded. The fake `run` records each call and fails those `fails` picks.
 */
export async function workspace(answers: AnswersInput, done: StepName[], token = TOKEN) {
  const cwd = mkdtempSync(join(tmpdir(), 'cosmicwave-setup-deploy-'));
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  let fails = (_call: Call) => false;
  const ctx: CliContext = {
    cwd,
    env: {},
    homeDir: join(cwd, 'home'),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    run: async (cmd, args, opts) => {
      const call = { cmd, args, cwd: opts?.cwd };
      calls.push(call);
      return fails(call)
        ? { code: 1, stdout: '', stderr: 'manifest unknown' }
        : { code: 0, stdout: '', stderr: '' };
    },
  };
  const run = (...argv: string[]) => runCli(argv, ctx);
  const p = workspacePaths(join(cwd, 'First Last', 'acme'));
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.answers, JSON.stringify(answers));
  expect(await run('setup', 'render', '--dir', p.root)).toBe(0);
  out.length = 0;
  updateEnvFile(p.envFile, {
    DISCORD_BOT_TOKEN: token,
    DISCORD_APP_ID: '100000000000000001',
    DISCORD_GUILD_ID: '200000000000000002',
  });
  for (const step of done) markDone(p, step, new Date());
  return {
    p,
    ctx,
    out,
    err,
    calls,
    run,
    deploy: () => run('setup', 'deploy', '--dir', p.root),
    failWhen: (pick: (call: Call) => boolean) => {
      fails = pick;
    },
  };
}
