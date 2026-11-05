// Reads the startup files `startupFiles` names (read-only) and returns one warning per hit.
import { readFileSync, statSync } from 'node:fs';
import type { CliContext } from '../context';
import { shadowLines, shadowWarning, startupFiles } from './shell-shadow';

const isFolder = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function shellShadowWarnings(ctx: CliContext, platform: NodeJS.Platform): string[] {
  const warnings: string[] = [];
  for (const file of startupFiles(platform, ctx.homeDir, ctx.env, isFolder)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // most of these files do not exist
    }
    for (const line of shadowLines(text)) warnings.push(shadowWarning(file, line));
  }
  return warnings;
}
