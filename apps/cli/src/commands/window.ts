import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  ownBranchPrefix,
  parseWindowPolicy,
  START_COMMAND,
  type WindowPolicy,
  windowFiles,
} from '@agentmesh/common/window';
import { parseCommandArgs, usageError } from '../args';
import { type CliContext, type Command, resolveFrom } from '../context';
import { writeFileAtomic } from '../lib/files';
import { findOnPath, isRegularFile } from '../lib/path-lookup';
import { shellShadowWarnings } from '../lib/shell-shadow-scan';
import { installShim, isOwnShim } from '../lib/shim';
import { bakeable, launcherScript, shimScripts, windowSettings } from '../render/window';
import { printStart } from './window-start';

const DEFAULT_TEMPLATE = 'agent/{owner}/{task}-{slug}';
const IGNORES = new Set(['.claude/worktrees/', '.claude/worktrees', '.claude/', '.claude']);

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** The folder itself and its direct subfolders that are git checkouts. */
function checkouts(dir: string): string[] {
  const found = existsSync(join(dir, '.git')) ? [dir] : [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    // an unreadable folder has no checkouts we can warn about
  }
  for (const n of names) {
    const sub = join(dir, n);
    if (existsSync(join(sub, '.git')) && statSync(sub).isDirectory()) found.push(sub);
  }
  return found;
}

const ignoresWorktrees = (checkout: string): boolean =>
  (read(join(checkout, '.gitignore')) ?? '').split(/\r?\n/).some((l) => IGNORES.has(l.trim()));

const isFolder = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const worktreeWarnings = (dir: string): string[] =>
  checkouts(dir)
    .filter((c) => !ignoresWorktrees(c))
    .map(
      (c) =>
        `Warning: ${c} doesn't ignore .claude/worktrees/; add it to .gitignore so the window's worktrees don't show up as untracked files.`,
    );

/** The environment the launcher bakes in, with every path it bakes checked. */
function launcherEnv(
  ctx: CliContext,
  platform: NodeJS.Platform,
  paths: string[],
): { userProfile: string | null; configDir: string | null } {
  const userProfile = ctx.env.USERPROFILE ?? null;
  const configDir = ctx.env.CLAUDE_CONFIG_DIR || null;
  // Claude Code would resolve a relative one (or a literal ~) from the team's folder.
  if (configDir && !isAbsolute(configDir)) {
    throw usageError(
      `CLAUDE_CONFIG_DIR is ${JSON.stringify(configDir)}, not an absolute path. Set it to an absolute path (no ~) and run window init again.`,
    );
  }
  for (const p of configDir ? [...paths, configDir] : paths) {
    if (!bakeable(p, platform, userProfile)) {
      throw usageError(
        `Cannot bake the path ${JSON.stringify(p)} into the launcher: it has characters a shell script would misread. Move it or use another home folder.`,
      );
    }
  }
  return { userProfile, configDir };
}

/** Whether anything, even a dangling link, is at `p`. */
const present = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** What follows the start line: a re-run note, then the warnings. */
function printNotes(
  ctx: CliContext,
  platform: NodeJS.Platform,
  n: { rerun: boolean; prefix: string | null; dir: string; emptyHooks: string },
): void {
  if (n.rerun) {
    ctx.stdout(
      'A mesh window that is already running keeps working; restart it to load the new settings.',
    );
  }
  if (n.prefix === null) {
    ctx.stdout(
      "Warning: the branch template's prefix (the part before {task} or any other placeholder) must name {owner} or {agent} and end in /, _ or . (like agent/{owner}/). Without one the window can't tell its own branches, so task worktrees, tests, commits, pushes and PRs all ask.",
    );
  }
  for (const w of shellShadowWarnings(ctx, platform)) ctx.stdout(w);
  for (const line of worktreeWarnings(n.dir)) ctx.stdout(line);
  if (readdirSync(n.emptyHooks).length > 0) {
    ctx.stdout(
      `Warning: ${n.emptyHooks} is not empty; git hooks found there would run in the mesh window. Empty it.`,
    );
  }
  ctx.stdout(
    "Check that each repo's test runner, typechecker and linter skip .claude/worktrees/ (vitest's default include does not).",
  );
}

export const windowInitCommand: Command = {
  name: 'window init',
  summary: 'Write the mesh window launcher, its settings and policy in ~/.agentmesh',
  help: `Usage: agentmesh window init --agent <id> [--owner <id>] [--branch-template <t>]
                            [--integration-branch <b>] [--test <command>]... [--dir <folder>]

Writes ~/.agentmesh/mesh-window.json (the policy), mesh-window.settings.json (passed to
claude --settings), the launcher (mesh-window.cmd on Windows, mesh-window elsewhere) and an
empty empty-git-hooks/ folder. It also writes claude-mesh, which runs the launcher: next to claude
when that folder is under your home folder and holds no claude-mesh of someone else's, else in
~/.agentmesh/bin, which you add to PATH. Start the window each day with claude-mesh in your team's
folder. Running it again keeps the window's token. With CLAUDE_CONFIG_DIR set, the window starts in
that Claude account.

--agent               your agent id (required)
--owner               your id in branch names (default: the agent id)
--branch-template     default ${DEFAULT_TEMPLATE}
--integration-branch  default agents
--test                a test command the window may run without asking; repeatable
--dir                 the folder the launcher is started in (default: the current folder)`,
  run(argv, ctx: CliContext) {
    const { values } = parseCommandArgs(
      argv,
      {
        agent: { type: 'string' },
        owner: { type: 'string' },
        'branch-template': { type: 'string', default: DEFAULT_TEMPLATE },
        'integration-branch': { type: 'string', default: 'agents' },
        test: { type: 'string', multiple: true },
        dir: { type: 'string' },
      },
      { min: 0, max: 0, names: '' },
    );
    const agentId = values.agent;
    if (!agentId) throw usageError('Missing --agent <id>');
    const platform = ctx.platform ?? process.platform;
    const files = windowFiles(ctx.homeDir, platform);
    const prefix = ownBranchPrefix(values['branch-template'], values.owner ?? agentId, agentId);
    const existing = read(files.policy);
    const kept = existing === null ? null : parseWindowPolicy(existing);
    const policy: WindowPolicy = {
      version: 1,
      agentId,
      token: kept?.token ?? randomBytes(16).toString('hex'),
      ownBranchPrefix: prefix,
      integrationBranch: values['integration-branch'],
      testCommands: values.test ?? [],
    };
    // One validator for every flag: the policy the window will read back.
    if (!parseWindowPolicy(JSON.stringify(policy))) {
      throw usageError(
        'Invalid input: --agent is lowercase letters, digits and dashes; --owner and --branch-template must give a plain branch prefix, --integration-branch a plain branch name; --test takes at most 10 plain commands (letters, digits, spaces and . _ : / = @ -, no shell characters).',
      );
    }
    const claude = findOnPath('claude', ctx.env, platform, isRegularFile);
    if (!claude) {
      ctx.stderr('error: claude is not on PATH. Install Claude Code first.');
      return 1;
    }
    const { userProfile, configDir } = launcherEnv(ctx, platform, [
      claude,
      files.settings,
      files.launcher,
    ]);
    const dir = resolveFrom(ctx, values.dir ?? '.');
    if (!isFolder(dir)) throw usageError(`--dir ${dir} is not a folder that exists.`);
    // Checked before anything is written: claude-mesh may have to go into ~/.agentmesh/bin.
    for (const p of [files.dir, files.bin]) {
      if (present(p) && !isFolder(p)) {
        throw usageError(`${p} is not a folder. Move it away and run window init again.`);
      }
    }
    const inputs = {
      agentId,
      claude,
      files,
      token: policy.token,
      testCommands: policy.testCommands,
      ownBranchPrefix: prefix,
      integrationBranch: policy.integrationBranch,
      userProfile,
      configDir,
    };

    mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    mkdirSync(files.emptyHooks, { recursive: true, mode: 0o700 });
    writeFileAtomic(files.policy, `${JSON.stringify(policy, null, 2)}\n`, 0o600);
    writeFileAtomic(files.settings, `${JSON.stringify(windowSettings(inputs), null, 2)}\n`, 0o600);
    writeFileAtomic(files.launcher, launcherScript(inputs, platform), 0o700);
    const shim = installShim(shimScripts(files.launcher, platform, userProfile), {
      claude,
      home: ctx.homeDir,
      fallbackDir: files.bin,
      platform,
    });

    ctx.stdout(
      `Wrote your mesh window for ${agentId}: ${files.launcher}, ${files.settings} and ${files.policy}.`,
    );
    // What typing claude-mesh runs now, on the PATH this command was started with.
    const reached = findOnPath(START_COMMAND, ctx.env, platform, isRegularFile);
    printStart(ctx, {
      platform,
      home: ctx.homeDir,
      dir,
      configDir,
      shim,
      reached,
      reachesOurs: reached !== null && isOwnShim(reached),
    });
    printNotes(ctx, platform, { rerun: kept !== null, prefix, dir, emptyHooks: files.emptyHooks });
    return 0;
  },
};
