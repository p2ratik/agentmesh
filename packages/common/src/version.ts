// Built-ins only: `@agentmesh/common/version` may be bundled where zod and pino are unwelcome.

/** The one AgentMesh version: every package.json, the plugin manifest and the plugin share it. */
export const VERSION = '0.6.0';

/** The first plugin whose mesh window takes a `relay` pointer for a private session. */
export const RELAY_MIN_VERSION = '0.6.0';

const DOTTED = /^\d+(\.\d+)*$/;

/** Numeric dotted compare (`0.10.0` ≥ `0.2.0`). Anything unparsable counts as old. Pure. */
export function isAtLeast(version: string, min: string): boolean {
  if (!DOTTED.test(version) || !DOTTED.test(min)) return false;
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}
