// Reads the startup files `startupFiles` names (read-only) and returns one warning per hit.
import { readFileSync, statSync } from 'node:fs';
import type { CliContext } from '../context';
import { definingFiles, shadowLines, shadowWarning, startupFiles } from './shell-shadow';

const isFolder = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Windows PowerShell 5.1 writes `>` and Out-File output as UTF-16LE with a BOM. */
function readText(file: string): string | null {
  try {
    const buf = readFileSync(file);
    return buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  } catch {
    return null; // most of these files do not exist
  }
}

export function shellShadowWarnings(ctx: CliContext, platform: NodeJS.Platform): string[] {
  const warnings: string[] = [];
  for (const file of startupFiles(platform, ctx.homeDir, ctx.env, isFolder)) {
    const text = readText(file);
    if (text === null) continue;
    for (const line of shadowLines(text, file.endsWith('.ps1'))) {
      warnings.push(shadowWarning(file, line));
    }
  }
  for (const file of definingFiles(ctx.homeDir)) {
    if (readText(file) !== null) warnings.push(shadowWarning(file, 1));
  }
  return warnings;
}
