import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MeshError } from '@agentmesh/common';

/** Relative paths of every file under `dir`, sorted, with forward slashes. */
export function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .map((rel) => rel.split('\\').join('/'))
    .sort();
}

/**
 * Copies a template directory. Refuses (copying nothing) when any target
 * file exists, unless `force` is set. Returns the files written.
 */
export function scaffold(from: string, to: string, force: boolean): string[] {
  const files = listFiles(from);
  const existing = files.filter((rel) => existsSync(join(to, rel)));
  if (existing.length > 0 && !force) {
    throw new MeshError(
      'conflict',
      `Refusing to overwrite existing files in ${to} (use --force):\n  ${existing.join('\n  ')}`,
    );
  }
  for (const rel of files) {
    const target = join(to, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(from, rel), target);
  }
  return files;
}
