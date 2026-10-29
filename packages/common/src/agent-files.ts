import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `~/.agentmesh`: the laptop's agent settings (`agent.json`) and seeds. */
export const agentmeshDir = (home = homedir()): string => join(home, '.agentmesh');

/** The mesh this laptop is already set up for, if any (`~/.agentmesh/agent.json`). */
export function existingMesh(home = homedir()): { agentId?: string; natsUrl?: string } | null {
  const file = join(agentmeshDir(home), 'agent.json');
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const pick = (k: string) => (typeof value[k] === 'string' ? (value[k] as string) : undefined);
    const agentId = pick('agentId');
    const natsUrl = pick('natsUrl');
    return agentId || natsUrl
      ? { ...(agentId ? { agentId } : {}), ...(natsUrl ? { natsUrl } : {}) }
      : null;
  } catch {
    return null;
  }
}
