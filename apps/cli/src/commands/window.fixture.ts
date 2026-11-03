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
  return { work, out, err, run, files, policy, home, root, bin };
}

/** What window init prints when claude-mesh had to go to ~/.agentmesh/bin. */
export const fallbackLines = (bin: string, work: string) => [
  `Add ${bin} to your PATH to use claude-mesh; window init never changes PATH.`,
  ...(platform === 'win32'
    ? [
        `Until then (PowerShell or Git Bash): ~/.agentmesh/mesh-window.cmd "${work}"`,
        `In cmd: "%USERPROFILE%\\.agentmesh\\mesh-window.cmd" "${work}"`,
      ]
    : [`Until then: ~/.agentmesh/mesh-window "${work}"`]),
];

export const startLine = (work: string) =>
  `Start it each day in any folder: claude-mesh (or claude-mesh "${work}" from anywhere)`;
