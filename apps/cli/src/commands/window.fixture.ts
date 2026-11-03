// Shared by the window init tests: a temp home, a fake claude on PATH and captured output.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWindowPolicy, windowFiles } from '@agentmesh/common/window';
import type { CliContext } from '../context';
import { runCli } from '../main';

export const platform = process.platform;
export const CLAUDE = platform === 'win32' ? 'claude.cmd' : 'claude';

export function setup(
  withClaude = true,
  homeName = 'home',
  binName = 'bin',
  env: CliContext['env'] = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'agentmesh-window-'));
  const home = join(root, homeName);
  const bin = join(root, binName);
  const work = join(root, 'work');
  for (const d of [home, bin, work]) mkdirSync(d, { recursive: true });
  if (withClaude) writeFileSync(join(bin, CLAUDE), '');
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    cwd: work,
    env: { PATH: withClaude ? bin : '', PATHEXT: '.CMD', USERPROFILE: home, ...env },
    homeDir: home,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    platform,
  };
  const files = windowFiles(home, platform);
  const run = (...argv: string[]) => runCli(['window', 'init', ...argv], ctx);
  const policy = () => parseWindowPolicy(readFileSync(files.policy, 'utf8'));
  return { work, out, err, run, files, policy, home, root, bin, ctx };
}

/**
 * The start lines printed while typing claude-mesh doesn't reach ours. Git Bash on Windows runs
 * the sh claude-mesh by its path (`bash`, `~/…` form).
 */
export const launcherLines = (work: string, bash = '~/.agentmesh/bin/claude-mesh') =>
  platform === 'win32'
    ? [
        `Until then, in PowerShell: ~/.agentmesh/mesh-window.cmd "${work}"`,
        `In Git Bash: ${bash} "${work}"`,
        `In cmd: "%USERPROFILE%\\.agentmesh\\mesh-window.cmd" "${work}"`,
      ]
    : [`Until then: ~/.agentmesh/mesh-window "${work}"`];

/** What window init prints when claude-mesh went to ~/.agentmesh/bin, which isn't on PATH. */
export const fallbackLines = (bin: string, work: string) => [
  `${bin} is not on your PATH: add it to use claude-mesh (window init never changes PATH).`,
  ...launcherLines(work),
];

export const startLine = (work: string) =>
  `Start it each day in any folder: claude-mesh (or claude-mesh "${work}" from anywhere)`;
