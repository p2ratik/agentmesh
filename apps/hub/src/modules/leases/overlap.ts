/**
 * Conservative overlap test for path globs: two patterns conflict when the
 * literal part of one (everything before its first glob character) is a
 * prefix of the other's. `api/**` conflicts with `api/types/**` and with
 * `api/index.ts`; `api/**` and `web/**` do not. False positives are fine (the
 * agents talk it out); false negatives are not.
 */
const GLOB_CHARS = /[*?[{]/;

export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

export function literalPrefix(path: string): string {
  const normalized = normalizePath(path);
  const at = normalized.search(GLOB_CHARS);
  return at === -1 ? normalized : normalized.slice(0, at);
}

export function pathsOverlap(a: string, b: string): boolean {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** A lease without a repo applies to every repo. */
export function reposOverlap(a: string | null, b: string | null): boolean {
  return a === null || b === null || a.toLowerCase() === b.toLowerCase();
}
