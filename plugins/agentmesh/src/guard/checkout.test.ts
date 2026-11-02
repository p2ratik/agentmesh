import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutTop, remoteRefExists } from './checkout';
import { type CommandContext, classifyCommand } from './commands';
import { asksAll, PASS, policy, UNLISTED } from './commands.fixture';
import { meshWorktreeOf, type PathOptions } from './paths';
import { fixture, link, mesh, OUTSIDE, put } from './paths.fixture';

let base: string;
let repo: string;
let o: PathOptions;
const OID = 'a'.repeat(40);

beforeEach(() => {
  ({ base, repo, o } = fixture());
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** The guard's command context as production builds it, from the real readers. */
function real(cwd: string): CommandContext {
  return {
    policy,
    cwd,
    worktreeOf: (dir) => {
      const w = meshWorktreeOf(dir, o);
      return 'refused' in w ? null : w;
    },
    checkoutTop: (dir) => checkoutTop(dir, o),
    remoteRefExists: (top, branch) => remoteRefExists(top, branch, o),
  };
}

/** A loose ref (or tag) in the checkout's git folder. */
const ref = (name: string, text = `${OID}\n`) => put(join(repo, '.git', ...name.split('/')), text);
const packed = (...lines: string[]) =>
  put(
    join(repo, '.git', 'packed-refs'),
    `# pack-refs with: peeled fully-peeled sorted \n${lines.join('\n')}\n`,
  );

describe('checkoutTop', () => {
  it('accepts the top of a real checkout, with or without .claude/worktrees', () => {
    expect(checkoutTop(repo, o)).toBe(repo);
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
    expect(checkoutTop(repo, o)).toBe(repo);
    // reached through a link, git and the check both land in the real checkout
    link(repo, join(base, 'alias'));
    expect(checkoutTop(join(base, 'alias'), o)).toBe(join(base, 'alias'));
  });

  it('refuses a subfolder, a worktree, links and odd paths', () => {
    expect(checkoutTop(join(repo, 'src'), o)).toBeNull();
    expect(checkoutTop(mesh(repo, 'mesh-a', 'agent/pratik/a'), o)).toBeNull(); // .git is a file
    expect(checkoutTop('relative/repo', o)).toBeNull();
    expect(checkoutTop(`${repo}/./`, o)).toBeNull();
    expect(checkoutTop(undefined as unknown as string, o)).toBeNull();

    const linkedGit = join(base, 'linked-git');
    mkdirSync(linkedGit);
    link(join(repo, '.git'), join(linkedGit, '.git'));
    expect(checkoutTop(linkedGit, o)).toBeNull();
  });

  it('refuses a checkout whose .claude or .claude/worktrees is a link or a file', () => {
    const skills = join(base, 'home', '.claude', 'skills');
    mkdirSync(skills, { recursive: true });
    link(skills, join(repo, '.claude'));
    expect(checkoutTop(repo, o)).toBeNull();
    rmSync(join(repo, '.claude'), { recursive: true, force: true });
    mkdirSync(join(repo, '.claude'));
    link(skills, join(repo, '.claude', 'worktrees'));
    expect(checkoutTop(repo, o)).toBeNull();
    rmSync(join(repo, '.claude'), { recursive: true, force: true });
    put(join(repo, '.claude'), 'a file');
    expect(checkoutTop(repo, o)).toBeNull();
  });
});

describe('remoteRefExists', () => {
  it('finds a loose or packed remote branch', () => {
    ref('refs/remotes/origin/agent/sagar/x');
    ref('refs/remotes/origin/HEAD', 'ref: refs/remotes/origin/agents\n');
    packed(`${'b'.repeat(40)} refs/remotes/origin/agents`, `^${'c'.repeat(40)}`);
    expect(remoteRefExists(repo, 'agent/sagar/x', o)).toBe(true);
    expect(remoteRefExists(repo, 'HEAD', o)).toBe(true);
    expect(remoteRefExists(repo, 'agents', o)).toBe(true);
  });

  it('is false for a tag of that name, a near name, odd names, junk and reftable', () => {
    ref('refs/tags/refs/remotes/origin/agent/sagar/evil');
    ref('refs/tags/origin/agents');
    packed(
      `${OID} refs/remotes/origin/agent/sagar/x-evil`,
      `${OID} refs/tags/refs/remotes/origin/agents`,
    );
    expect(remoteRefExists(repo, 'agent/sagar/evil', o)).toBe(false);
    expect(remoteRefExists(repo, 'agents', o)).toBe(false);
    expect(remoteRefExists(repo, 'agent/sagar/x', o)).toBe(false);
    // names git refuses or Windows opens as something else; the safe-to-create ones exist on disk
    ref('refs/remotes/origin/x.lock');
    ref('refs/remotes/origin/a/.x');
    for (const name of [
      '',
      'a..b',
      '-x',
      'x/',
      'a//b',
      'x.',
      'a/.x',
      'x.lock',
      'nul',
      'agent/con.txt',
    ]) {
      expect([name, remoteRefExists(repo, name, o)]).toEqual([name, false]);
    }
    ref('refs/remotes/origin/junk', 'not an oid\n');
    expect(remoteRefExists(repo, 'junk', o)).toBe(false);
    mkdirSync(join(repo, '.git', 'refs', 'remotes', 'origin', 'folder'), { recursive: true });
    expect(remoteRefExists(repo, 'folder', o)).toBe(false);

    ref('refs/remotes/origin/fine');
    expect(remoteRefExists(repo, 'fine', o)).toBe(true);
    mkdirSync(join(repo, '.git', 'reftable'));
    expect(remoteRefExists(repo, 'fine', o)).toBe(false);
  });
});

describe('worktree changes with the real readers', () => {
  const review = 'git worktree add .claude/worktrees/mesh-y refs/remotes/origin/agent/sagar/evil';
  const own = 'git worktree add .claude/worktrees/mesh-z -b agent/pratik/z --track origin/agents';

  it('passes from the checkout top for a fetched remote branch', () => {
    ref('refs/remotes/origin/agent/sagar/evil');
    expect(classifyCommand(review, real(repo))).toEqual(PASS);
    expect(classifyCommand(own, real(repo))).toEqual(PASS);
  });

  it('asks when only a tag carries the remote branch name (tag shadowing)', () => {
    ref('refs/tags/refs/remotes/origin/agent/sagar/evil');
    expect(classifyCommand(review, real(repo))).toEqual(UNLISTED);
  });

  it('asks inside a review worktree whose branch fakes a checkout with a linked folder (C1)', () => {
    ref('refs/remotes/origin/agent/sagar/evil');
    const wt = mesh(repo, 'mesh-review-task-2', 'agent/sagar/evil');
    const fake = join(wt, '.claude', 'worktrees', 'x');
    const skills = join(base, 'home', '.claude', 'skills');
    mkdirSync(join(fake, '.claude'), { recursive: true });
    mkdirSync(skills, { recursive: true });
    link(skills, join(fake, '.claude', 'worktrees'));
    // the innermost .claude/worktrees/x isn't mesh-*, so no worktree is found there
    expect(meshWorktreeOf(fake, o)).toEqual(OUTSIDE);
    for (const cwd of [fake, wt, join(wt, '.claude', 'worktrees')]) {
      expect(classifyCommand(review, real(cwd))).toEqual(UNLISTED);
      expect(classifyCommand(own, real(cwd))).toEqual(UNLISTED);
      expect(classifyCommand('git worktree remove .claude/worktrees/mesh-y', real(cwd))).toEqual(
        UNLISTED,
      );
    }
  });
});

describe('worktree change forms', () => {
  it('refuses worktree changes with other paths, slugs, flags or start points', () => {
    const wt = '.claude/worktrees/mesh-x';
    const remote = 'refs/remotes/origin/agents';
    const track = '--track origin/agents';
    asksAll(
      [
        `git worktree add ${wt} ${remote} -f`,
        `git worktree add ${wt} ${remote} --force`,
        `git worktree add -B agent/pratik/x ${wt} ${track}`,
        `git worktree add ${wt} -B agent/pratik/x ${track}`,
        `git worktree add ${wt} --detach ${remote}`,
        `git worktree add ${wt} --lock ${remote}`,
        `git worktree add .claude/worktrees/mesh-X ${remote}`,
        `git worktree add .claude/worktrees/mesh- ${remote}`,
        `git worktree add .claude/worktrees/mesh--x ${remote}`,
        `git worktree add .claude/worktrees/mesh-${'a'.repeat(64)} ${remote}`,
        `git worktree add ${wt}/../../../x ${remote}`,
        `git worktree add ../${wt} ${remote}`,
        `git worktree add /tmp/${wt} ${remote}`,
        `git worktree add ./${wt} ${remote}`,
        `git worktree add ${wt} refs/remotes/origin/-x`,
        `git worktree add ${wt} ${remote}:x`,
        `git worktree add ${wt} ${remote}^`,
        `git worktree add ${wt} agents`,
        `git worktree add ${wt} upstream/agents`,
        `git worktree add ${wt}`,
        `git worktree add ${wt} -b agent/pratik/ ${track}`,
        `git worktree add ${wt} -b agent/pratik/a..b ${track}`,
        `git worktree add ${wt} -b agent/pratik/x ${track} origin/main`,
        `git worktree add ${wt} -b agent/pratik/x --track HEAD`,
        `git worktree add ${wt} -b agent/pratik/x --track origin/main`,
        `git worktree add ${wt} -b agent/pratik/x --track origin/-x`,
        `git worktree add ${wt} -b agent/pratik/x --no-track origin/agents`,
        `git worktree add ${wt} -b agent/pratik/x --track=inherit origin/agents`,
        `git worktree add ${wt} -b agent/pratik/x  ${track}`,
        `git worktree remove ${wt} -f`,
        `git worktree remove ${wt}/..`,
        'git worktree remove ../x',
        'git worktree prune',
        `git worktree move ${wt} x`,
      ],
      'C:/t',
    );
  });
});
