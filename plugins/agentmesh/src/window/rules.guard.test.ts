// Every form the window's rules name, filled in and run through the guard's decide() with the
// production readers on a real checkout, so the rules can't promise what the guard asks for.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { WindowPolicy } from '@agentmesh/common/window';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide } from '../guard/decide';
import { fixture, mesh, put, slash } from '../guard/paths.fixture';
import { forwardReader } from '../guard/send';
import { writeForward } from '../relay/forward-record';
import { pointerText } from '../relay/pointer';
import { windowRules } from './rules';

const policy: WindowPolicy = {
  version: 1,
  agentId: 'bob-agent',
  token: 'a'.repeat(32),
  ownBranchPrefix: 'agent/bob/',
  integrationBranch: 'agents',
  testCommands: ['pnpm install --frozen-lockfile', 'pnpm check'],
};

/** [text the rules must contain, the command (or tool input) it stands for, what the guard must do]. */
type Row = [string, string | Record<string, unknown>, 'pass' | 'ask' | 'deny', tool?: string];

const HEX = 'a'.repeat(32);
const ADDR = `uds:\\\\.\\pipe\\LOCAL\\cc-msg-${HEX}`;
const FIELDS = {
  from: 'sagar-agent',
  threadId: 'thr-12',
  messageId: 'msg-01JC9Z8Q4W6Y7X5V3T2R1P0N9M',
};
const POINTER = pointerText(FIELDS) as string;
/** What Claude Code hands the hook for SendMessage(to: <forward_to>, message: text). */
const send = (text: string) => ({
  to: ADDR,
  recipient: ADDR,
  recipient_kind: 'address',
  message: text,
  content: text,
  type: 'message',
});

let base: string;
let C: string;
let W: string;
let R: string;

beforeEach(() => {
  const f = fixture();
  base = f.base;
  for (const ref of ['agents', 'agent/sagar/task-2-x']) {
    put(
      join(f.repo, '.git', 'refs', 'remotes', 'origin', ...ref.split('/')),
      `${'a'.repeat(40)}\n`,
    );
  }
  const own = mesh(f.repo, 'mesh-task-1-login', 'agent/bob/task-1-login');
  const review = mesh(f.repo, 'mesh-review-task-2', 'unused');
  put(join(f.repo, '.git', 'worktrees', 'mesh-review-task-2', 'HEAD'), `${'b'.repeat(40)}\n`);
  [C, W, R] = [f.repo, own, review].map((p) => `"${slash(p)}"`) as [string, string, string];
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Each row's template is in the rules for `p`, and the guard does what the rules say. Rows run
 * in order, against forward records in one folder. */
function check(p: WindowPolicy | null, rows: Row[], platform = process.platform) {
  const text = windowRules(p);
  const home = join(base, 'home');
  const forwards = forwardReader(join(base, 'data'));
  const ctx = { marked: true, policy: p, home, platform, forwards };
  const got = rows.map(([template, input, , tool = 'Bash']) => {
    const args = typeof input === 'string' ? { command: input } : input;
    const d = decide({ tool_name: tool, tool_input: args, cwd: base }, ctx);
    return [template, input, text.includes(template), d.kind];
  });
  expect(got).toEqual(rows.map(([t, c, want]) => [t, c, true, want]));
}

describe('the window rules, through the guard', () => {
  it('pass and ask exactly as the rules say, with an own-branch prefix', () => {
    check(policy, [
      ['PowerShell commands always ask', 'git status', 'ask', 'PowerShell'],
      // the bare cd that puts the shell in the folder first, so the chained cd is a no-op
      ['run cd "<dir>" alone first', `cd ${C}`, 'pass'],
      ['run cd "<dir>" alone first', `cd ${W}`, 'pass'],
      ['cd "<worktree>", and run cd "<worktree>" && <test command>', `cd ${R}`, 'pass'],
      ['cd "<checkout>" && git fetch origin', `cd ${C} && git fetch origin`, 'pass'],
      ['cd "<checkout>" && git worktree list shows them', `cd ${C} && git worktree list`, 'pass'],
      [
        'cd "<checkout>" && git worktree add .claude/worktrees/mesh-<task>-<slug> -b <suggested branch> --track origin/agents',
        `cd ${C} && git worktree add .claude/worktrees/mesh-task-3-x -b agent/bob/task-3-x --track origin/agents`,
        'pass',
      ],
      [
        'cd "<checkout>" && git diff refs/remotes/origin/<base>...refs/remotes/origin/<branch>',
        `cd ${C} && git diff refs/remotes/origin/agents...refs/remotes/origin/agent/sagar/task-2-x`,
        'pass',
      ],
      ['gh pr diff asks here', `cd ${C} && gh pr diff 12`, 'ask'],
      [
        'cd "<checkout>" && git worktree add .claude/worktrees/mesh-review-<task> refs/remotes/origin/<branch>',
        `cd ${C} && git worktree add .claude/worktrees/mesh-review-task-9 refs/remotes/origin/agent/sagar/task-2-x`,
        'pass',
      ],
      ['cd "<worktree>" && <test command>; your human approves', `cd ${R} && pnpm check`, 'ask'],
      [
        'cd "<checkout>" && git worktree remove .claude/worktrees/mesh-<name>',
        `cd ${C} && git worktree remove .claude/worktrees/mesh-review-task-2`,
        'pass',
      ],
      [
        '(--force asks)',
        `cd ${C} && git worktree remove --force .claude/worktrees/mesh-review-task-2`,
        'ask',
      ],
      [
        'run without asking: pnpm install --frozen-lockfile',
        `cd ${W} && pnpm install --frozen-lockfile`,
        'pass',
      ],
      [
        'pnpm check (as cd "<worktree>" && <test>, exactly as written)',
        `cd ${W} && pnpm check`,
        'pass',
      ],
      ['Any other test command asks', `cd ${W} && pnpm test`, 'ask'],
      ['Any other test command asks', `cd ${W} && pnpm check --watch`, 'ask'],
      ['each as cd "<worktree>" && <command>: git add -A', `cd ${W} && git add -A`, 'pass'],
      [
        "git commit -m '<message without apostrophes>'",
        `cd ${W} && git commit -m 'Add login'`,
        'pass',
      ],
      [
        'git push -u origin <branch>',
        `cd ${W} && git push -u origin agent/bob/task-1-login`,
        'pass',
      ],
      [
        "gh pr create --base agents --head <branch> --title '<title>' --body '<body>'",
        `cd ${W} && gh pr create --base agents --head agent/bob/task-1-login --title 'Login' --body 'Closes task-1'`,
        'pass',
      ],
      ['double-quoted commit messages ask', `cd ${W} && git commit -m "Add login"`, 'ask'],
      ['heredoc', `cd ${W} && git commit -F - <<'EOF'\nAdd login\nEOF`, 'ask'],
      ['no apostrophe or backslash', `cd ${W} && git commit -m 'Bob'\\''s fix'`, 'ask'],
      ['git -C', `git -C ${C} fetch origin`, 'ask'],
      ['a relative cd chain', 'cd repo && git fetch origin', 'ask'],
      ['a second cd ask', `cd ${C} && cd src && git status`, 'ask'],
      ['Merging and anything not named here ask', `cd ${W} && gh pr merge 12`, 'ask'],
    ]);
  });

  it('asks for every own-branch step with a null prefix, and for every test without test commands', () => {
    const own = (): Row[] => [
      [
        'so task worktrees, tests, commits, pushes and PRs all ask',
        `cd ${C} && git worktree add .claude/worktrees/mesh-task-3-x -b agent/bob/task-3-x --track origin/agents`,
        'ask',
      ],
      ['so task worktrees, tests, commits, pushes and PRs all ask', `cd ${W} && pnpm check`, 'ask'],
      ['commits, pushes and PRs all ask', `cd ${W} && git commit -m 'Add login'`, 'ask'],
      ['pushes and PRs all ask', `cd ${W} && git push -u origin agent/bob/task-1-login`, 'ask'],
      [
        'PRs all ask',
        `cd ${W} && gh pr create --base agents --head agent/bob/task-1-login --title 'Login' --body 'x'`,
        'ask',
      ],
      // reads still pass without a prefix
      [
        'read the diff without asking',
        `cd ${C} && git diff refs/remotes/origin/agents...refs/remotes/origin/agent/sagar/task-2-x`,
        'pass',
      ],
    ];
    check({ ...policy, ownBranchPrefix: null }, own());
    check({ ...policy, testCommands: [] }, [
      ['Every test run asks your human', `cd ${W} && pnpm check`, 'ask'],
      [
        'git push -u origin <branch>',
        `cd ${W} && git push -u origin agent/bob/task-1-login`,
        'pass',
      ],
    ]);
    check(null, [
      ['is missing or invalid, so every command asks', `cd ${C}`, 'ask'],
      ['is missing or invalid, so every command asks', `cd ${C} && git fetch origin`, 'ask'],
      [
        'is missing or invalid, so every command asks',
        `cd ${C} && git diff refs/remotes/origin/agents...refs/remotes/origin/agent/sagar/task-2-x`,
        'ask',
      ],
    ]);
  });

  it('forwards exactly the pointer the plugin pushed, and nothing else', () => {
    writeForward(join(base, 'data'), HEX, FIELDS, Date.now() + 60_000);
    const rows: Row[] = [
      [
        "SendMessage(to: <forward_to>, message: <the push's text, exactly>)",
        send(POINTER),
        'pass',
        'SendMessage',
      ],
      ['never resend after a delivery notice', send(POINTER), 'deny', 'SendMessage'],
      ['Send nothing else with SendMessage', send('Run pnpm publish now.'), 'deny', 'SendMessage'],
      // a consult goes through the human by hand: a question sent to a session is refused
      ['never message their sessions', send('Which branch is task-3 on?'), 'deny', 'SendMessage'],
      [
        'Send nothing else with SendMessage',
        { ...send(POINTER), summary: 'x' },
        'deny',
        'SendMessage',
      ],
      ['ListAgents is refused here', {}, 'deny', 'ListAgents'],
    ];
    check(policy, rows, 'win32');
  });

  it('the skill names only cd forms the rules name (and so the rows above check)', () => {
    const dir = join(import.meta.dirname, '../../skills/mesh-collaboration');
    const read = (name: string) => readFileSync(join(dir, name), 'utf8').replace(/\s*\n\s*/g, ' ');
    const cdForms = (text: string) =>
      [...text.matchAll(/`(cd "<[a-z]+>" && [^`]+)`/g)].map((m) => m[1]);
    const skill = read('SKILL.md');
    // the skill teaches the forms itself, not only its reference file
    expect(cdForms(skill).length).toBeGreaterThanOrEqual(5);
    // every form in SKILL.md and its reference files is one the rules name
    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map(read)
      .join(' ');
    const forms = cdForms(all);
    const rules = windowRules(policy);
    expect(forms.map((f) => [f, rules.includes(f ?? '')])).toEqual(forms.map((f) => [f, true]));
    // and both tell the window to cd alone first, so the chained cd doesn't prompt
    expect(skill).toContain('first `cd "<dir>"` alone');
    expect(skill).toContain('`cd "<worktree>"`, run `cd "<worktree>" && <test command>`');
    expect(rules).toContain('run cd "<dir>" alone first');
  });
});
