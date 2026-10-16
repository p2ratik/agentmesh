#!/usr/bin/env node
// Keeps the codebase maintainable: fails when any source file grows past the limit.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MAX_LINES = Number(process.env.MAX_FILE_LINES ?? 300);
const ROOTS = ['packages', 'apps', 'plugins'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'data']);
const EXTENSIONS = ['.ts', '.mts', '.js', '.mjs'];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTENSIONS.some((ext) => full.endsWith(ext))) yield full;
  }
}

const offenders = [];
for (const root of ROOTS) {
  let files;
  try {
    files = [...walk(root)];
  } catch {
    continue;
  }
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n').length;
    if (lines > MAX_LINES) offenders.push({ file: relative('.', file), lines });
  }
}

if (offenders.length > 0) {
  console.error(`Files over ${MAX_LINES} lines (split them into focused modules):`);
  for (const { file, lines } of offenders) console.error(`  ${file}: ${lines}`);
  process.exit(1);
}
console.log(`All source files are within ${MAX_LINES} lines.`);
