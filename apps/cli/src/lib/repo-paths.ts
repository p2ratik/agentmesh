import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshError } from '@agentmesh/common';

/**
 * The AgentMesh checkout this CLI runs from: the nearest ancestor of the
 * module that contains `config/examples/mesh.yaml`. Works from `src/` (tsx)
 * and from the bundled `dist/main.js` alike.
 */
export function findRepoRoot(moduleUrl: string = import.meta.url): string | null {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    if (existsSync(join(dir, 'config', 'examples', 'mesh.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `config/examples`, the single source of truth that `agentmesh init` copies. */
export function findExamplesDir(moduleUrl: string = import.meta.url): string {
  const root = findRepoRoot(moduleUrl);
  if (!root) {
    throw new MeshError(
      'not_found',
      'Could not find config/examples next to the agentmesh CLI. Run it from an AgentMesh checkout.',
    );
  }
  return join(root, 'config', 'examples');
}
