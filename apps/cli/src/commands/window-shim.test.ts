import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isBelow } from '../lib/shim';
import { shimScripts } from '../render/window';
import { CLAUDE, fallbackLines, launcherLines, platform, setup, startLine } from './window.fixture';

const SHIMS = platform === 'win32' ? ['claude-mesh.cmd', 'claude-mesh'] : ['claude-mesh'];
/** A claude installed under the home folder, as the native installer does. */
const HOME_BIN = join('home', '.local', 'bin');
const OLD_SHIM = '#!/bin/sh\n# agentmesh claude-mesh\nexec /old/launcher "$@"\n';

const shimOf = (s: ReturnType<typeof setup>, name: string) =>
  shimScripts(s.files.launcher, platform, s.home).find((x) => x.name === name)?.content;
const files = (dir: string) => readdirSync(dir).sort();
const absent = (p: string) => expect(() => statSync(p)).toThrow();

describe('window init writes claude-mesh', () => {
  it('next to a claude under the home folder, which is on PATH already', async () => {
    const s = setup(true, 'home', HOME_BIN);
    expect(await s.run('--agent', 'bob-agent')).toBe(0);
    expect(files(s.bin)).toEqual([CLAUDE, ...SHIMS].sort());
    for (const name of SHIMS) expect(readFileSync(join(s.bin, name), 'utf8')).toBe(shimOf(s, name));
    if (platform !== 'win32') expect(statSync(join(s.bin, 'claude-mesh')).mode & 0o777).toBe(0o755);
    expect(s.out.slice(2, 4)).toEqual([`Wrote claude-mesh to ${s.bin}.`, startLine(s.work)]);
    expect(s.out.join('\n')).not.toContain('PATH');
    absent(s.files.bin);
  });

  it('into ~/.agentmesh/bin when claude is outside the home folder', async () => {
    const s = setup();
    expect(await s.run('--agent', 'bob-agent')).toBe(0);
    expect(files(s.bin)).toEqual([CLAUDE]);
    expect(files(s.files.bin)).toEqual([...SHIMS].sort());
    expect(s.out.slice(2, 4 + fallbackLines('', '').length)).toEqual([
      `Wrote claude-mesh to ${s.files.bin}.`,
      startLine(s.work),
      ...fallbackLines(s.files.bin, s.work),
    ]);
  });

  it.skipIf(platform !== 'win32' && process.getuid?.() === 0)(
    "into ~/.agentmesh/bin when claude's folder takes no write",
    async () => {
      const s = setup(true, 'home', HOME_BIN);
      if (platform === 'win32') {
        // Windows can't rename over a read-only file, even one of ours.
        writeFileSync(join(s.bin, 'claude-mesh.cmd'), OLD_SHIM);
        chmodSync(join(s.bin, 'claude-mesh.cmd'), 0o444);
      } else {
        chmodSync(s.bin, 0o555);
      }
      try {
        expect(await s.run('--agent', 'bob-agent')).toBe(0);
      } finally {
        chmodSync(platform === 'win32' ? join(s.bin, 'claude-mesh.cmd') : s.bin, 0o755);
      }
      expect(files(s.files.bin)).toEqual([...SHIMS].sort());
      // On Windows the read-only claude-mesh.cmd left beside claude still comes first on PATH.
      expect(s.out).toContain(
        platform === 'win32'
          ? `Warning: claude-mesh runs ${join(s.bin, 'claude-mesh.cmd')}, which comes first on PATH, not ${join(s.files.bin, 'claude-mesh.cmd')}.`
          : fallbackLines(s.files.bin, s.work)[0],
      );
    },
  );

  it("leaves a claude-mesh it didn't write alone, and falls back", async () => {
    for (const name of SHIMS) {
      const s = setup(true, 'home', HOME_BIN);
      const foreign = join(s.bin, name);
      writeFileSync(foreign, 'echo not ours\n');
      expect(await s.run('--agent', 'bob-agent')).toBe(0);
      expect(readFileSync(foreign, 'utf8')).toBe('echo not ours\n');
      expect(files(s.bin)).toEqual([CLAUDE, name].sort());
      expect(files(s.files.bin)).toEqual([...SHIMS].sort());
      expect(s.out.slice(2, 5)).toEqual([
        `Left ${foreign} alone: AgentMesh didn't write it.`,
        `Wrote claude-mesh to ${s.files.bin}.`,
        startLine(s.work),
      ]);
    }
  });

  it('says which claude-mesh wins when another comes first on PATH', async () => {
    const s = setup(true, 'home', HOME_BIN);
    const early = join(s.root, 'early');
    mkdirSync(early);
    const other = join(early, SHIMS[0] as string);
    writeFileSync(other, 'echo not ours\n');
    s.ctx.env.PATH = [early, s.bin].join(delimiter);
    expect(await s.run('--agent', 'bob-agent')).toBe(0);
    expect(s.out.slice(3, 5 + launcherLines('').length)).toEqual([
      startLine(s.work),
      `Warning: claude-mesh runs ${other}, which comes first on PATH, not ${join(s.bin, SHIMS[0] as string)}.`,
      ...launcherLines(s.work),
    ]);
  });

  it('says nothing more from ~/.agentmesh/bin once that folder is on PATH', async () => {
    const s = setup();
    s.ctx.env.PATH = [s.bin, s.files.bin].join(delimiter);
    expect(await s.run('--agent', 'bob-agent')).toBe(0);
    expect(s.out.slice(2, 4)).toEqual([`Wrote claude-mesh to ${s.files.bin}.`, startLine(s.work)]);
    expect(s.out.join('\n')).not.toMatch(/PATH|Until then/);
  });

  it('rewrites its own claude-mesh, by the marker line', async () => {
    const s = setup(true, 'home', HOME_BIN);
    for (const name of SHIMS) writeFileSync(join(s.bin, name), OLD_SHIM);
    expect(await s.run('--agent', 'bob-agent')).toBe(0);
    for (const name of SHIMS) expect(readFileSync(join(s.bin, name), 'utf8')).toBe(shimOf(s, name));
    absent(s.files.bin);
    expect(await s.run('--agent', 'bob-agent')).toBe(0);
    expect(files(s.bin)).toEqual([CLAUDE, ...SHIMS].sort());
  });

  it('writes nothing outside the home folder and the folder of claude', async () => {
    for (const s of [setup(), setup(true, 'home', HOME_BIN)]) {
      expect(await s.run('--agent', 'bob-agent', '--dir', s.work)).toBe(0);
      const written = readdirSync(s.root, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name));
      for (const p of written) {
        const inHome = !relative(s.home, p).startsWith('..');
        expect(inHome || relative(s.bin, p) === CLAUDE || SHIMS.includes(relative(s.bin, p))).toBe(
          true,
        );
      }
      expect(files(s.work)).toEqual([]);
    }
  });
});

describe('isBelow', () => {
  it('compares without case on windows and macOS only', () => {
    expect(isBelow('C:\\USERS\\BOB\\.local\\bin', 'C:\\Users\\bob', 'win32')).toBe(true);
    expect(isBelow('/Users/BOB/.local/bin', '/Users/bob', 'darwin')).toBe(true);
    expect(isBelow('/home/BOB/.local/bin', '/home/bob', 'linux')).toBe(false);
    expect(isBelow('/home/bob/.local/bin', '/home/bob', 'linux')).toBe(true);
  });

  it('wants a folder strictly below the home folder', () => {
    expect(isBelow('/home/bob', '/home/bob', 'linux')).toBe(false);
    expect(isBelow('/home/bobby/bin', '/home/bob', 'linux')).toBe(false);
    expect(isBelow('/usr/local/bin', '/home/bob', 'linux')).toBe(false);
    expect(isBelow('D:\\tools', 'C:\\Users\\bob', 'win32')).toBe(false);
    expect(isBelow('/home/bob/..foo', '/home/bob', 'linux')).toBe(true);
  });
});
