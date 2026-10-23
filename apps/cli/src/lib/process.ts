import { spawn } from 'node:child_process';

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunProcess = (
  cmd: string,
  args: readonly string[],
  opts?: { input?: string; cwd?: string },
) => Promise<ProcessResult>;

/**
 * Runs a program (ssh, scp, docker) without a shell, so no argument is ever parsed by one.
 * `input` goes to stdin. It never rejects: a program missing from PATH is exit 127.
 */
export const runProcess: RunProcess = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    // 'error' comes before 'close' when the spawn fails; the first resolve wins.
    child.on('error', (error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT';
      resolve({
        code: missing ? 127 : 1,
        stdout,
        stderr: missing ? `${cmd} not found on PATH` : error.message,
      });
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    // A program that exits without reading its input must not crash us with EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input);
  });
