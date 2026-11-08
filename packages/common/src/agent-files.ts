import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `~/.agentmesh`: the laptop's agent settings (`agent.json`) and seeds. */
export const agentmeshDir = (home = homedir()): string => join(home, '.agentmesh');

/** What `agent.json` holds; a field it lacks, or has as an empty or non-string value, is absent. */
export interface SavedMesh {
  agentId?: string;
  natsUrl?: string;
  /** The seed's file (or the seed itself). */
  nkeySeed?: string;
  prefix?: string;
}

const FIELDS = ['agentId', 'natsUrl', 'nkeySeed', 'prefix'] as const;

/** The mesh this laptop is already set up for, if any (`~/.agentmesh/agent.json`). */
export function existingMesh(home = homedir()): SavedMesh | null {
  const file = join(agentmeshDir(home), 'agent.json');
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const saved: SavedMesh = {};
    for (const k of FIELDS) {
      const v = value[k];
      if (typeof v === 'string' && v) saved[k] = v;
    }
    return saved.agentId || saved.natsUrl ? saved : null;
  } catch {
    return null;
  }
}
