import { execFile } from 'node:child_process';
import { GitRef } from '@agentmesh/protocol';

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

/** The repo and branch git reported, keeping only what the hub's GitRef takes: git allows a branch
 * name the hub refuses (U+2028, U+0085), which would fail hello and drop every heartbeat. */
export function toGitInfo(remote: string | undefined, branch: string | undefined): GitInfo {
  const repo = remote ? parseRemote(remote) : undefined;
  const ok = (v: string | undefined): v is string => !!v && GitRef.safeParse(v).success;
  return { ...(ok(repo) ? { repo } : {}), ...(ok(branch) && branch !== 'HEAD' ? { branch } : {}) };
}

/** Which repo and branch this session works in (best effort; never throws). */
export async function readGitInfo(cwd: string): Promise<GitInfo> {
  const [remote, branch] = await Promise.all([
    git(['remote', 'get-url', 'origin'], cwd),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
  ]);
  return toGitInfo(remote, branch);
}
