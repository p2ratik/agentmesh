import { MeshError } from '@agentmesh/common';
import type { ProcessResult, RunProcess } from '../lib/process';

/**
 * Never prompt (the admin's key works or the command fails), and trust a server's host key
 * on first contact but refuse one that changes later. Every ssh/scp argument list puts `--`
 * right before the destination, so a target can never be read as an option.
 */
export const SSH_OPTIONS: readonly string[] = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new',
];

/** The login user of a validated `user@host` (`hosting.ssh`). */
export function sshUser(target: string): string {
  return target.slice(0, target.indexOf('@'));
}

const STDERR_TAIL_LINES = 20;

/** Runs a command; a non-zero exit throws with `what` and the last lines of its stderr. */
export async function runChecked(
  run: RunProcess,
  cmd: string,
  args: readonly string[],
  opts: { input?: string; cwd?: string } | undefined,
  what: string,
): Promise<ProcessResult> {
  const result = await run(cmd, args, opts);
  if (result.code === 0) return result;
  const tail = result.stderr.trimEnd().split(/\r?\n/).slice(-STDERR_TAIL_LINES).join('\n');
  throw new MeshError('unavailable', `${what} failed (exit ${result.code}):\n${tail}`);
}
