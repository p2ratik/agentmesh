import { linkSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editTarget, meshWorktreeOf, type PathOptions } from './paths';
import {
  AGENTMESH,
  admin,
  canLinkFiles,
  DEVICE,
  DOT_GIT,
  fixture,
  link,
  mesh,
  NOT_ABSOLUTE,
  OUTSIDE,
  put,
  slash,
  UNREGISTERED,
  win32,
} from './paths.fixture';

let base: string;
let repo: string;
let o: PathOptions;
let wt: string;
const sep = win32 ? '\\' : '/';

function refusedBoth(path: string, refusal: { refused: string }) {
  expect(meshWorktreeOf(path, o)).toEqual(refusal);
  expect(editTarget(path, o)).toEqual(refusal);
}

beforeEach(() => {
  ({ base, repo, o } = fixture());
  wt = mesh(repo, 'mesh-a', 'agent/pratik/task-1-a');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('path spellings', () => {
  it('refuses . and .. segments and untrimmed paths, whatever they would resolve to', () => {
    link(join(wt, 'd1', 'd2', 'd3', 'd4', 'd5'), join(wt, 'a'));
    mkdirSync(join(wt, 'd1', 'd2', 'd3', 'd4', 'd5'), { recursive: true });
    link(join(repo, 'src'), join(wt, 'out'));
    for (const path of [
      [wt, '..', '..', '..', 'src', 'a.ts'].join(sep),
      [wt, '..', 'x.ts'].join(sep),
      [wt, 'missing', '..', '..', '..', '..', 'src', 'a.ts'].join(sep),
      [wt, 'a', '..', '..', '..', '..', 'src', 'evil.ts'].join(sep),
      [wt, 'out', '..', 'x.ts'].join(sep),
      `${slash(wt)}/sub/../a.ts`,
      [wt, '.', 'a.ts'].join(sep),
      [wt, 'sub', '.'].join(sep),
      ` ${join(wt, 'a.ts')}`,
      `${join(wt, 'a.ts')} `,
      `${join(wt, 'a.ts')}\n`,
      `\t${join(wt, 'a.ts')}`,
    ]) {
      refusedBoth(path, NOT_ABSOLUTE);
    }
  });

  it('never throws for a path or home that is not a string', () => {
    for (const path of [undefined, null, 42, {}]) {
      refusedBoth(path as unknown as string, NOT_ABSOLUTE);
    }
    const home = undefined as unknown as string;
    expect(editTarget(join(wt, 'a.ts'), { ...o, home })).toEqual(NOT_ABSOLUTE);
  });

  it.runIf(win32)('refuses device, UNC and stream paths', () => {
    for (const path of [
      '\\\\?\\C:\\x\\a.ts',
      `\\\\?\\${join(wt, 'a.ts')}`,
      '\\\\.\\pipe\\x',
      '\\\\server\\share\\a.ts',
      '//?/C:/x/a.ts',
      '//./pipe/x',
      '//server/share/a.ts',
      '\\??\\C:\\x\\a.ts',
      'C:\\r\\a.ts:evil',
      `${join(wt, 'a.ts')}::$DATA`,
    ]) {
      refusedBoth(path, DEVICE);
    }
  });

  it.runIf(win32)('refuses a segment ending in a dot or space (Win32 drops them)', () => {
    mkdirSync(join(wt, 'sub', '.git'), { recursive: true });
    link(join(repo, 'src'), join(wt, 'out'));
    for (const path of [
      `${wt}\\out.\\a.ts`,
      `${wt}\\out \\a.ts`,
      `${wt}\\sub\\.git. \\config`,
      `${wt}\\sub\\.git.\\hooks\\pre-commit`,
      `${wt}\\a.ts.`,
      `${wt}\\.../a.ts`,
    ]) {
      refusedBoth(path, DEVICE);
    }
  });

  it.runIf(win32)('refuses DOS device names, with or without an extension', () => {
    const one = String.fromCharCode(0xb9);
    for (const name of ['nul', 'CON', 'com1.ts', 'aux.txt', 'NUL .txt', `lpt${one}`, 'conout$']) {
      refusedBoth(join(wt, name), DEVICE);
      refusedBoth(join(wt, name, 'a.ts'), DEVICE);
    }
    for (const name of ['console.ts', 'com10.ts', 'auxiliary.ts', 'nul-ish.ts']) {
      expect(editTarget(join(wt, name), o)).toEqual({ ok: true });
    }
  });
});

describe('what the write would really touch', () => {
  it('refuses a hard link', () => {
    linkSync(join(repo, 'src', 'a.ts'), join(wt, 'hl.ts'));
    expect(editTarget(join(wt, 'hl.ts'), o)).toEqual(OUTSIDE);
    put(join(wt, 'own.ts'));
    linkSync(join(wt, 'own.ts'), join(wt, 'twin.ts'));
    expect(editTarget(join(wt, 'own.ts'), o)).toEqual(OUTSIDE);
    put(join(wt, 'plain.ts'));
    expect(editTarget(join(wt, 'plain.ts'), o)).toEqual({ ok: true });
  });

  it('refuses a last segment that is itself a link, even one into the worktree', () => {
    mkdirSync(join(wt, 'dir'));
    link(join(wt, 'dir'), join(wt, 'lnk'));
    expect(editTarget(join(wt, 'lnk'), o)).toEqual(OUTSIDE);
    expect(editTarget(join(wt, 'lnk', 'a.ts'), o)).toEqual({ ok: true });
    link(join(wt, 'dir'), join(repo, 'src', 'in'));
    expect(editTarget(join(repo, 'src', 'in'), o)).toEqual(OUTSIDE);
  });

  it('refuses a .git that is a folder link', () => {
    unlinkSync(join(wt, '.git'));
    link(admin(repo, 'mesh-a'), join(wt, '.git'));
    refusedBoth(join(wt, 'a.ts'), UNREGISTERED);
  });

  it.runIf(canLinkFiles)('refuses a .git file symlink, and file symlinks out or in', () => {
    put(join(repo, 'src', 'gitfile'), `gitdir: ${slash(admin(repo, 'mesh-a'))}\n`);
    unlinkSync(join(wt, '.git'));
    symlinkSync(join(repo, 'src', 'gitfile'), join(wt, '.git'), 'file');
    refusedBoth(join(wt, 'a.ts'), UNREGISTERED);

    const other = mesh(repo, 'mesh-b', 'agent/pratik/task-2-b');
    symlinkSync(join(repo, 'src', 'a.ts'), join(other, 'out.ts'), 'file');
    refusedBoth(join(other, 'out.ts'), OUTSIDE);
    put(join(other, 'real.ts'));
    symlinkSync(join(other, 'real.ts'), join(other, 'in.ts'), 'file');
    expect(editTarget(join(other, 'in.ts'), o)).toEqual(OUTSIDE);
    expect(editTarget(join(other, 'real.ts'), o)).toEqual({ ok: true });
  });

  it.skipIf(win32)('refuses .git and ~/.agentmesh in any case, even with platform linux', () => {
    const linux: PathOptions = { ...o, platform: 'linux' };
    expect(editTarget(join(wt, '.GIT', 'config'), linux)).toEqual(DOT_GIT);
    expect(editTarget(join(wt, '.Git'), linux)).toEqual(DOT_GIT);
    expect(editTarget(join(o.home, '.AgentMesh', 'agent.json'), linux)).toEqual(AGENTMESH);
    expect(editTarget(join(wt, 'a.ts'), linux)).toEqual({ ok: true });
  });
});
