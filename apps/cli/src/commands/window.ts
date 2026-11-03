import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  LAUNCHER_DISPLAY,
  ownBranchPrefix,
  parseWindowPolicy,
  type WindowPolicy,
  windowFiles,
} from '@agentmesh/common/window';
import { parseCommandArgs, usageError } from '../args';
import { type CliContext, type Command, resolveFrom } from '../context';
import { writeFileAtomic } from '../lib/files';
import { findOnPath, isRegularFile } from '../lib/path-lookup';
import { bakeable, launcherScript, windowSettings } from '../render/window';

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

/** What follows the "Wrote …" lines: a re-run note, then the warnings. */
function printNotes(
  ctx: CliContext,
  n: { rerun: boolean; prefix: string | null; dir: string; emptyHooks: string },
): void {
  if (n.rerun) {
    ctx.stdout(
      'A mesh window that is already running keeps working; restart it to load the new settings.',
    );
  }
  if (n.prefix === null) {
    ctx.stdout(
      "Warning: the branch template names neither the owner nor the agent, so the window can't tell its own branches: every test run will ask.",
    );
  }
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
empty empty-git-hooks/ folder. Start the window each day with the launcher, in your team's folder.
Running it again keeps the window's token.

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
    for (const p of [claude, files.settings]) {
      if (!bakeable(p, platform)) {
        throw usageError(
          `Cannot bake the path ${JSON.stringify(p)} into the launcher: it has characters a shell script would misread. Move it or use another home folder.`,
        );
      }
    }
    const dir = resolveFrom(ctx, values.dir ?? '.');
    if (!isFolder(dir)) throw usageError(`--dir ${dir} is not a folder that exists.`);
    const inputs = {
      agentId,
      claude,
      files,
      token: policy.token,
      testCommands: policy.testCommands,
      ownBranchPrefix: prefix,
      integrationBranch: policy.integrationBranch,
    };

    mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    mkdirSync(files.emptyHooks, { recursive: true, mode: 0o700 });
    writeFileAtomic(files.policy, `${JSON.stringify(policy, null, 2)}\n`, 0o600);
    writeFileAtomic(files.settings, `${JSON.stringify(windowSettings(inputs), null, 2)}\n`, 0o600);
    writeFileAtomic(files.launcher, launcherScript(inputs, platform), 0o700);

    ctx.stdout(
      `Wrote your mesh window for ${agentId}: ${files.launcher}, ${files.settings} and ${files.policy}.`,
    );
    ctx.stdout(`Start it each day in your team's folder: ${LAUNCHER_DISPLAY} "${dir}"`);
    printNotes(ctx, { rerun: kept !== null, prefix, dir, emptyHooks: files.emptyHooks });
    return 0;
  },
};
