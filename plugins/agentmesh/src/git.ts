import { execFile } from 'node:child_process';

export interface GitInfo {
  repo?: string;
  branch?: string;
}

/** `owner/name` from an https or ssh remote URL, or undefined. */
export function parseRemote(url: string): string | undefined {
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1];
}

function git(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 2000, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  });
}

/** Which repo and branch this session works in (best effort; never throws). */
export async function readGitInfo(cwd: string): Promise<GitInfo> {
  const [remote, branch] = await Promise.all([
    git(['remote', 'get-url', 'origin'], cwd),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
  ]);
  const repo = remote ? parseRemote(remote) : undefined;
  return { ...(repo ? { repo } : {}), ...(branch && branch !== 'HEAD' ? { branch } : {}) };
}
