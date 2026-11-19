// Built-ins only (node:*): the plugin's hook and guard bundles import this on every call. Which
// folder holds this laptop's identity (agent.json, the seeds), and the one move from the folder's
// old name. The move renames the folder in one call and never copies or deletes anything.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

export const HOME_DIR = '.cosmicwave';
export const LEGACY_HOME_DIR = '.agentmesh';
export type HomeDirName = typeof HOME_DIR | typeof LEGACY_HOME_DIR;
export type MoveResult = 'moved' | 'nothing' | 'failed' | 'both';

export interface HomeFs {
  existsSync(path: string): boolean;
  renameSync(from: string, to: string): void;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, text: string): void;
  rmSync(path: string): void;
}

const AGENT_FILE = 'agent.json';

const nodeFs: HomeFs = {
  existsSync,
  renameSync,
  readFileSync,
  // agent.json is the user's alone, like every file join writes there.
  writeFileSync: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  rmSync: (path) => rmSync(path, { force: true }),
};

/**
 * What a member does when both folders exist, which depends on where agent.json is. Never tells
 * anyone to remove the folder that holds it: while `~/.cosmicwave` has none, the keys are in
 * `~/.agentmesh`, so the new folder goes into the old one and the one rename runs again.
 */
export function bothFoldersAdvice(
  home = homedir(),
  exists: (p: string) => boolean = existsSync,
): string {
  if (exists(join(home, HOME_DIR, AGENT_FILE))) {
    return 'Both ~/.cosmicwave and ~/.agentmesh exist, and ~/.cosmicwave holds your agent.json, so ~/.agentmesh is a leftover. Look inside it first and move anything you still need into ~/.cosmicwave (key files ending in .nk, an agent.json, a backup key); only then remove ~/.agentmesh.';
  }
  return 'Both ~/.cosmicwave and ~/.agentmesh exist, and ~/.cosmicwave has no agent.json, so ~/.agentmesh is the folder to keep. Move what you put in ~/.cosmicwave into ~/.agentmesh, remove the then-empty ~/.cosmicwave, and start Claude Code again (or run cmw window init again): ~/.agentmesh is then renamed to ~/.cosmicwave with everything in it. Change nothing in ~/.agentmesh by hand.';
}

/**
 * The folder that holds this laptop's identity: `.cosmicwave` when it has agent.json, else
 * `.agentmesh` when that has it (not moved yet, or a leftover beside an empty new folder), else
 * `.agentmesh` when only that folder exists, else `.cosmicwave`.
 */
export function homeDirName(
  home: string,
  exists: (p: string) => boolean = existsSync,
): HomeDirName {
  if (exists(join(home, HOME_DIR, AGENT_FILE))) return HOME_DIR;
  if (exists(join(home, LEGACY_HOME_DIR, AGENT_FILE))) return LEGACY_HOME_DIR;
  const onlyLegacy = exists(join(home, LEGACY_HOME_DIR)) && !exists(join(home, HOME_DIR));
  return onlyLegacy ? LEGACY_HOME_DIR : HOME_DIR;
}

/** `~/.cosmicwave`, or `~/.agentmesh` on a laptop whose folder could not be moved yet. */
export function meshHome(home = homedir(), exists?: (p: string) => boolean): string {
  return join(home, homeDirName(home, exists));
}

/**
 * Renames `~/.agentmesh` to `~/.cosmicwave`. Only the plugin's MCP server (at start) and `cmw
 * window init` call it; no other CLI command, and never the hook or guard. `both` and `nothing`
 * change nothing; a rename that throws changed nothing either, unless another process won the
 * race (`moved`). After its own move it points agent.json's seed path at the new folder.
 */
export function moveLegacyHome(home = homedir(), fs: HomeFs = nodeFs): MoveResult {
  const from = join(home, LEGACY_HOME_DIR);
  const to = join(home, HOME_DIR);
  const hasLegacy = fs.existsSync(from);
  if (hasLegacy && fs.existsSync(to)) return 'both';
  if (!hasLegacy) return 'nothing';
  try {
    fs.renameSync(from, to);
  } catch {
    return fs.existsSync(to) ? 'moved' : 'failed';
  }
  rewriteSeed(home, fs);
  return 'moved';
}

/** agent.json's seed path, mapped into the moved folder: a temp file beside it, then a rename.
 * Any failure leaves the file as it was (the readers map the path too) and removes the temp file. */
function rewriteSeed(home: string, fs: HomeFs): void {
  const file = join(home, HOME_DIR, AGENT_FILE);
  const temp = `${file}.tmp`;
  let wrote = false;
  try {
    if (!fs.existsSync(file)) return;
    const saved: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return;
    const seed = (saved as Record<string, unknown>).nkeySeed;
    if (typeof seed !== 'string') return;
    const mapped = mapLegacyPath(seed, home, fs.existsSync);
    if (mapped === seed) return;
    wrote = true;
    fs.writeFileSync(temp, `${JSON.stringify({ ...saved, nkeySeed: mapped }, null, 2)}\n`);
    fs.renameSync(temp, file);
  } catch {
    try {
      if (wrote) fs.rmSync(temp);
    } catch {
      // best effort: a temp file left behind holds agent.json's settings, never a key
    }
  }
}

/**
 * A path under `<home>/.agentmesh` or `~/.agentmesh`, as the same path under `<home>/.cosmicwave`
 * once the old file is gone. `\` compares as `/`, and case folds on win32 only. Anything else (a
 * seed literal, another folder, a path with `..`) comes back unchanged. Never throws.
 */
export function mapLegacyPath(
  file: string,
  home: string,
  exists: (p: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string {
  try {
    const fold = (s: string) => {
      const slashed = s.replaceAll('\\', '/');
      return platform === 'win32' ? slashed.toLowerCase() : slashed;
    };
    const top = home.replaceAll('\\', '/').replace(/\/+$/, '');
    const base = [`${top}/${LEGACY_HOME_DIR}/`, `~/${LEGACY_HOME_DIR}/`].find(
      (b) => fold(file.slice(0, b.length)) === fold(b),
    );
    if (!base) return file;
    const rest = file.slice(base.length).replaceAll('\\', '/').split('/');
    if (rest.includes('..')) return file;
    const lib = platform === 'win32' ? win32 : posix;
    if (exists(lib.join(home, LEGACY_HOME_DIR, ...rest))) return file;
    return lib.join(home, HOME_DIR, ...rest);
  } catch {
    return file;
  }
}
