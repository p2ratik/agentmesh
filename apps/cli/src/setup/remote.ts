import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MeshError, redactSecrets } from '@agentmesh/common';
import type { CliContext } from '../context';
import type { ProcessResult, RunProcess } from '../lib/process';

/**
 * Never prompt (the admin's key works or the command fails), and trust a server's host key
 * on first contact but refuse one that changes later. Give up after 15 s when port 22 drops
 * packets, and never reuse a shared connection: one opened before `setup host` added the
 * user to the docker group lacks that group. Every ssh/scp argument list puts `--` right
 * before the destination, so a target can never be read as an option.
 */
export const SSH_OPTIONS: readonly string[] = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'ConnectTimeout=15',
  '-o',
  'ControlPath=none',
];

/**
 * The ssh or scp to run. On Windows, the system OpenSSH when it is installed: Claude Code's
 * shell puts Git's ssh first on PATH, and that one cannot use keys in the Windows ssh-agent.
 * Only `processContext` sets `ctx.platform`, so tests get the plain name on any platform.
 */
export function sshProgram(name: 'ssh' | 'scp', ctx: Pick<CliContext, 'platform' | 'env'>): string {
  const root = ctx.env.SystemRoot;
  if (ctx.platform !== 'win32' || !root) return name;
  const system = join(root, 'System32', 'OpenSSH', `${name}.exe`);
  return existsSync(system) ? system : name;
}

/** The login user of a validated `user@host` (`hosting.ssh`). */
export function sshUser(target: string): string {
  return target.slice(0, target.indexOf('@'));
}

const STDERR_TAIL_LINES = 20;

/**
 * Runs a command; a non-zero exit throws with `what` and the last lines of its stderr, with
 * secrets masked: Docker Compose echoes a malformed `.env` line, bot token included.
 */
export async function runChecked(
  run: RunProcess,
  cmd: string,
  args: readonly string[],
  opts: { input?: string; cwd?: string } | undefined,
  what: string,
): Promise<ProcessResult> {
  const result = await run(cmd, args, opts);
  if (result.code === 0) return result;
  const lines = result.stderr.trimEnd().split(/\r?\n/).slice(-STDERR_TAIL_LINES);
  const tail = redactSecrets(lines.join('\n'));
  throw new MeshError('unavailable', `${what} failed (exit ${result.code}):\n${tail}`);
}
