import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutLine, findCheckout, originRepo } from './checkouts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'am-checkouts-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function clone(dir: string, url: string) {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(
    join(dir, '.git', 'config'),
    `[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:Other/Thing.git\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
}

describe('originRepo', () => {
  it('reads the origin url, not another remote', () => {
    clone(join(root, 'web'), 'git@github.com:Acme/Web.git');
    expect(originRepo(join(root, 'web'))).toBe('Acme/Web');
  });

  it('skips a worktree (.git is a file) and a folder with no git', () => {
    mkdirSync(join(root, 'wt'));
    writeFileSync(join(root, 'wt', '.git'), 'gitdir: /elsewhere');
    mkdirSync(join(root, 'plain'));
    // a .git that is a link to a real checkout's folder is not read either
    clone(join(root, 'real'), 'git@github.com:Acme/Web.git');
    mkdirSync(join(root, 'linked'));
    symlinkSync(join(root, 'real', '.git'), join(root, 'linked', '.git'), 'junction');
    expect(originRepo(join(root, 'linked'))).toBeNull();
    expect(originRepo(join(root, 'wt'))).toBeNull();
    expect(originRepo(join(root, 'plain'))).toBeNull();
  });
});

describe('findCheckout', () => {
  it('finds a subfolder case-insensitively', () => {
    clone(join(root, 'web'), 'git@github.com:Acme/Web.git');
    expect(findCheckout('acme/web', root)).toEqual({ path: join(root, 'web') });
  });

  it('finds the folder itself', () => {
    clone(root, 'https://github.com/Acme/Web');
    expect(findCheckout('Acme/Web', root)).toEqual({ path: root });
  });

  it('reports none and several', () => {
    expect(findCheckout('acme/web', root)).toEqual({
      problem: `no git checkout in ${root} has origin acme/web. Ask your human for its path; never clone it.`,
    });
    clone(join(root, 'a'), 'git@github.com:Acme/Web.git');
    clone(join(root, 'b'), 'https://github.com/acme/web.git');
    expect(findCheckout('acme/web', root)).toEqual({
      problem: `2 checkouts in ${root} have origin acme/web (${join(root, 'a')}, ${join(root, 'b')}). Ask your human which one to use.`,
    });
  });

  it('skips a linked worktree next to the real checkout', () => {
    clone(join(root, 'web'), 'git@github.com:Acme/Web.git');
    mkdirSync(join(root, 'web-wt'));
    writeFileSync(join(root, 'web-wt', '.git'), 'gitdir: x');
    expect(findCheckout('acme/web', root)).toEqual({ path: join(root, 'web') });
  });
});

describe('checkoutLine', () => {
  it('words each case', () => {
    clone(join(root, 'web'), 'git@github.com:Acme/Web.git');
    expect(checkoutLine('acme/web', root)).toBe(`checkout: ${join(root, 'web')}`);
    expect(checkoutLine(null, root)).toBe(
      'checkout: this task names no repo. Ask your human which checkout to use.',
    );
  });
});
