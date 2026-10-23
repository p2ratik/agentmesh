import { readFileSync } from 'node:fs';
import { MeshError } from '@agentmesh/common';
import { writePrivateFile } from '../lib/files';

/**
 * Reads and edits `deploy/.env` the way Docker Compose reads it, so the CLI sees the
 * same token as the hub. Values never appear in errors: the file holds the bot token.
 */

/** `KEY=value` → `[key, raw value]`; comments and other lines → undefined. */
function splitLine(line: string): [string, string] | undefined {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/s.exec(line);
  return match ? [match[1] as string, (match[2] as string).trim()] : undefined;
}

/** Strips whitespace and surrounding quotes; an unquoted value loses a ` # comment`. */
export function parseEnv(text: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of text.split('\n')) {
    const entry = splitLine(line);
    if (!entry) continue;
    const [key, raw] = entry;
    const quoted = /^(["'])(.*)\1(\s+#.*)?$/.exec(raw);
    env.set(key, quoted ? (quoted[2] as string) : raw.replace(/\s+#.*$/, ''));
  }
  return env;
}

/** Replaces each `KEY=` line in place, keeping comments and order; appends missing keys. */
export function setEnvValues(text: string, values: Record<string, string>): string {
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) {
      throw new MeshError('invalid_request', `The value for ${key} must be a single line`);
    }
  }
  const found = new Set<string>();
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = (body ? body.split('\n') : []).map((line) => {
    const key = splitLine(line)?.[0];
    if (key === undefined || !Object.hasOwn(values, key)) return line;
    found.add(key);
    return `${key}=${values[key]}${line.endsWith('\r') ? '\r' : ''}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!found.has(key)) lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n')}\n`;
}

export function readEnvFile(path: string): Map<string, string> {
  return parseEnv(readFileSync(path, 'utf8'));
}

/** Sets values in an existing `.env`, which stays readable only by its owner. */
export function updateEnvFile(path: string, values: Record<string, string>): void {
  writePrivateFile(path, setEnvValues(readFileSync(path, 'utf8'), values), true);
}
