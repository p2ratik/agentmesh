import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutTop, freeSlot, remoteRefExists } from './checkout';
import { classifyCommand } from './commands';
import { asksAll, PASS, realContext, UNLISTED } from './commands.fixture';
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

const real = (cwd: string) => realContext(o, cwd);

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

  it('matches each loose segment by its exact name on disk (case twins)', () => {
    // on win32 and darwin git opens .../case as the file Case, another branch's ref
    ref('refs/remotes/origin/agent/sagar/Case');
    ref('refs/remotes/origin/Team/x');
    packed(`${OID} refs/remotes/origin/agent/sagar/case`);
    expect(remoteRefExists(repo, 'agent/sagar/Case', o)).toBe(true);
    expect(remoteRefExists(repo, 'Team/x', o)).toBe(true);
    expect(remoteRefExists(repo, 'agent/sagar/case', o)).toBe(false);
    expect(remoteRefExists(repo, 'agent/sagar/CASE', o)).toBe(false);
    expect(remoteRefExists(repo, 'team/x', o)).toBe(false);
  });
});

describe('freeSlot', () => {
  it('is true only when nothing is at the worktree path', () => {
    expect(freeSlot(repo, 'mesh-y', o)).toBe(true);
    mkdirSync(join(repo, '.claude', 'worktrees', 'mesh-empty'), { recursive: true });
    expect(freeSlot(repo, 'mesh-empty', o)).toBe(false);
    put(join(repo, '.claude', 'worktrees', 'mesh-file'));
    expect(freeSlot(repo, 'mesh-file', o)).toBe(false);
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

  it('asks when the slot is already a link to an empty folder, or anything else', () => {
    ref('refs/remotes/origin/agent/sagar/evil');
    const empty = join(base, 'home', '.claude', 'skills', 'mesh-y');
    mkdirSync(empty, { recursive: true });
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
    link(empty, join(repo, '.claude', 'worktrees', 'mesh-y'));
    expect(classifyCommand(review, real(repo))).toEqual(UNLISTED);
    mkdirSync(join(repo, '.claude', 'worktrees', 'mesh-z'));
    expect(classifyCommand(own, real(repo))).toEqual(UNLISTED);
    const remove = 'git worktree remove .claude/worktrees/mesh-z';
    expect(classifyCommand(remove, real(repo))).toEqual(PASS);
  });

  it('reads with arguments only from inside a checkout or worktree (I2b)', () => {
    // a review branch commits k -> ~/.ssh; outside a repo git diff runs as --no-index through it
    const wt = mesh(repo, 'mesh-fake', 'agent/sagar/evil');
    const ssh = join(base, 'home', '.ssh');
    put(join(ssh, 'id_ed25519'), 'PRIVATE KEY');
    put(join(repo, 'f'), 'a');
    mkdirSync(join(wt, '.claude', 'worktrees', 'x'), { recursive: true });
    link(ssh, join(wt, '.claude', 'worktrees', 'x', 'k'));
    const key = '.claude/worktrees/mesh-fake/.claude/worktrees/x/k/id_ed25519';
    expect(classifyCommand(`git diff repo/${key} repo/f`, real(base))).toEqual(UNLISTED);
    expect(classifyCommand(`git log -p repo/${key}`, real(base))).toEqual(UNLISTED);
    expect(classifyCommand('git diff', real(base))).toEqual(PASS);
    // inside a repo git keeps relative paths in its tree
    expect(classifyCommand(`git diff ${key} f`, real(repo))).toEqual(PASS);
    const inner = '.claude/worktrees/x/k/id_ed25519';
    expect(classifyCommand(`git diff ${inner} f`, real(wt))).toEqual(PASS);
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
