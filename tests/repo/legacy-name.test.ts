import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// scripts/check-legacy-name.mjs: the old product name may appear only in the files it allows.
const SCRIPT = resolve('scripts/check-legacy-name.mjs');
const dirs: string[] = [];

const run = (root?: string) =>
  spawnSync('node', [SCRIPT, ...(root ? [root] : [])], { encoding: 'utf8' });

/** A throwaway git repo (identity set inside it only) tracking the given files. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-name-'));
  dirs.push(dir);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  git('add', '.');
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('check-legacy-name', () => {
  // It reads every tracked file: 24 s on a loaded Windows laptop, over the default 20 s.
  it('passes on this repository', () => {
    const r = run();
    expect(r.stdout).toContain('The old name appears only where it is meant to.');
    expect(r.status).toBe(0);
  }, 120_000);

  it('names a file that brings the old name back', () => {
    const r = run(repo({ 'x.md': 'AgentMesh\n' }));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('x.md:1');
  });

  it('ignores the protected local paths', () => {
    const r = run(repo({ 'x.md': 'cd G:\\Projects\\AgentMesh-relay\n' }));
    expect(r.status).toBe(0);
  });
});
