// What window init prints about starting the window: the account, claude-mesh, the start line.
import { isAbsolute, join, relative } from 'node:path';
import { LAUNCHER_CMD, launcherDisplay, START_COMMAND } from '@agentmesh/common/window';
import type { CliContext } from '../context';
import type { ShimPlace } from '../lib/shim';

/** The sh claude-mesh in `dir` as Git Bash types it: `~/…` below the home folder. */
function gitBashCommand(dir: string, home: string): string {
  const rel = relative(home, dir);
  const inHome = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  const path = (inHome ? rel : dir.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`))
    .split('\\')
    .join('/');
  return `${inHome ? '~/' : ''}${/^[\w./-]+$/.test(path) ? path : `'${path}'`}/${START_COMMAND}`;
}

export interface StartFacts {
  platform: NodeJS.Platform;
  home: string;
  dir: string;
  configDir: string | null;
  shim: ShimPlace;
  /** What typing claude-mesh runs now (cmd's lookup), and whether that file is one of ours. */
  reached: string | null;
  reachesOurs: boolean;
}

/**
 * Which Claude account the window uses, where claude-mesh went and the start line. While typing
 * claude-mesh doesn't reach one of ours (shadowed, or its folder isn't on PATH), also which file it
 * does reach and the start lines that work meanwhile (three on Windows).
 */
export function printStart(ctx: CliContext, s: StartFacts): void {
  ctx.stdout(
    s.configDir
      ? `The window uses the Claude account in ${s.configDir} (CLAUDE_CONFIG_DIR).`
      : 'The window uses your default Claude account (~/.claude).',
  );
  for (const p of s.shim.foreign) ctx.stdout(`Left ${p} alone: AgentMesh didn't write it.`);
  ctx.stdout(`Wrote ${START_COMMAND} to ${s.shim.dir}.`);
  ctx.stdout(
    `Start it each day in any folder: ${START_COMMAND} (or ${START_COMMAND} "${s.dir}" from anywhere)`,
  );
  if (s.reachesOurs) return;
  // cmd and PowerShell look up the .cmd, so that is the file PATH must reach on Windows.
  const ours = join(s.shim.dir, `${START_COMMAND}${s.platform === 'win32' ? '.cmd' : ''}`);
  ctx.stdout(
    s.reached
      ? `Warning: ${START_COMMAND} runs ${s.reached}, which comes first on PATH, not ${ours}.`
      : `${s.shim.dir} is not on your PATH: add it to use ${START_COMMAND} (window init never changes PATH).`,
  );
  const line = `${launcherDisplay(s.platform)} "${s.dir}"`;
  if (s.platform !== 'win32') {
    ctx.stdout(`Until then: ${line}`);
    return;
  }
  // Git Bash hands cmd two quoted strings when a .cmd path has a space: it runs the sh one.
  ctx.stdout(`Until then, in PowerShell: ${line}`);
  ctx.stdout(`In Git Bash: ${gitBashCommand(s.shim.dir, s.home)} "${s.dir}"`);
  ctx.stdout(`In cmd: ${LAUNCHER_CMD} "${s.dir}"`);
}
