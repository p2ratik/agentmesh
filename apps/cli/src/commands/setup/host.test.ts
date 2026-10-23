import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../../context';
import type { ProcessResult } from '../../lib/process';
import { runCli } from '../../main';
import { renderHostScript } from '../../setup/render/host-script';
import { type AnswersInput, serverAnswers, trialAnswers } from '../../setup/testing';
import { readState, workspacePaths } from '../../setup/workspace';

const OK: ProcessResult = { code: 0, stdout: '', stderr: '' };

/** A workspace with `answers`, a fake `run` answering `result` and a fake resolver. */
function harness(answers: AnswersInput, result = OK, resolves = true) {
  const cwd = mkdtempSync(join(tmpdir(), 'agentmesh-setup-host-'));
  const p = workspacePaths(join(cwd, 'ws'));
  mkdirSync(p.root);
  writeFileSync(p.answers, JSON.stringify(answers));
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ cmd: string; args: readonly string[]; input?: string }> = [];
  const lookups: string[] = [];
  const ctx: CliContext = {
    cwd,
    env: {},
    homeDir: join(cwd, 'home'),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, input: opts?.input });
      return result;
    },
    lookup: async (host) => {
      lookups.push(host);
      if (resolves) return ['203.0.113.10'];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
  };
  const host = () => runCli(['setup', 'host', '--dir', p.root], ctx);
  return { p, out, err, calls, lookups, host };
}

describe('setup host', () => {
  it('pipes the host script to sudo bash over ssh', async () => {
    const t = harness(serverAnswers());
    expect(await t.host()).toBe(0);
    expect(t.lookups).toEqual(['mesh.acme.dev']);
    expect(t.calls).toHaveLength(1);
    const [call] = t.calls;
    expect(call?.cmd).toBe('ssh');
    expect(call?.args).toContain('BatchMode=yes');
    expect(call?.args).toContain('StrictHostKeyChecking=accept-new');
    expect(call?.args.slice(-3)).toEqual(['--', 'deploy@mesh.acme.dev', 'sudo bash -s']);
    expect(call?.input).toBe(
      renderHostScript({
        publicHost: 'mesh.acme.dev',
        remoteDir: '/opt/agentmesh',
        user: 'deploy',
      }),
    );
    expect(readState(t.p).done.host).toBeDefined();
  });

  it('stops before ssh when DNS does not resolve', async () => {
    const t = harness(serverAnswers(), OK, false);
    expect(await t.host()).toBe(1);
    expect(t.err).toEqual([
      'DNS for mesh.acme.dev does not resolve yet. Point an A record at the server, wait a minute, and run again.',
    ]);
    expect(t.calls).toEqual([]);
    expect(readState(t.p).done.host).toBeUndefined();
  });

  it('has nothing to do on a trial', async () => {
    const t = harness(trialAnswers());
    expect(await t.host()).toBe(0);
    expect(t.out).toEqual(['Nothing to do on a trial.']);
    expect(t.calls).toEqual([]);
    expect(t.lookups).toEqual([]);
    expect(readState(t.p).done.host).toBeDefined();
  });

  it('a failed ssh is not marked done and shows the end of its stderr', async () => {
    const stderr = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const t = harness(serverAnswers(), { code: 255, stdout: '', stderr: `${stderr}\n` });
    expect(await t.host()).toBe(1);
    const message = t.err.join('\n');
    expect(message).toContain('Preparing the server failed (exit 255):');
    expect(message).toContain('line 11\n');
    expect(message).toMatch(/line 30$/);
    expect(message).not.toContain('line 10\n');
    expect(readState(t.p).done.host).toBeUndefined();
  });

  it('masks a token that a failing command echoes from .env', async () => {
    // Discord-token-shaped and fake; built at runtime so secret scanners skip it.
    const token = [`MTIz${'A'.repeat(22)}`, 'GaBcDe', 'F'.repeat(34)].join('.');
    const stderr = [
      `failed to read /opt/agentmesh/deploy/.env: line 3: unterminated quoted value "${token}`,
      `unexpected character "\\"" in variable name "\\"DISCORD_BOT_TOKEN=${token}\\""`,
    ].join('\n');
    const t = harness(serverAnswers(), { code: 1, stdout: '', stderr });
    expect(await t.host()).toBe(1);
    const message = t.err.join('\n');
    expect(message).toContain('unterminated quoted value "[REDACTED]');
    expect(message).toContain('DISCORD_BOT_TOKEN=[REDACTED]');
    expect(message).not.toContain(token);
  });
});
