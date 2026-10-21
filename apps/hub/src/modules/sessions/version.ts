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
