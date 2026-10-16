/**
 * Replaces `${NAME}` and `${NAME:-fallback}` in every string of a parsed YAML
 * tree. Interpolating after parsing (not in the raw text) means a variable's
 * value can never change the document's structure.
 */
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export interface InterpolationResult<T> {
  value: T;
  missing: string[];
}

export function interpolateEnv<T>(
  tree: T,
  env: Record<string, string | undefined> = process.env,
): InterpolationResult<T> {
  const missing = new Set<string>();

  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return node.replace(PLACEHOLDER, (_match, name: string, fallback?: string) => {
        const value = env[name];
        if (value !== undefined && value !== '') return value;
        if (fallback !== undefined) return fallback;
        missing.add(name);
        return '';
      });
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visit(v)]));
    }
    return node;
  };

  return { value: visit(tree) as T, missing: [...missing].sort() };
}
