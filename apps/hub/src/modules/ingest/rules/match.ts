import type { Condition, RuleMatch } from '@agentmesh/config';
import type { Severity } from '@agentmesh/protocol';

/** What rules and templates can see of an event. */
export interface RuleContext {
  id: string;
  source: string;
  type: string;
  severity: Severity;
  summary: string | null;
  url: string | null;
  occurredAt: string | null;
  payload: Record<string, unknown>;
}

const SEVERITY_ORDER: readonly Severity[] = ['debug', 'info', 'warning', 'error', 'critical'];

/**
 * Reads a dotted path (`payload.workflow_run.head_branch`); arrays accept
 * numeric segments. Only own properties are visible, so `constructor` or
 * `__proto__` can never reach into JavaScript internals.
 */
export function lookup(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function typeMatches(patterns: readonly string[], type: string): boolean {
  return patterns.some((p) => (p.endsWith('*') ? type.startsWith(p.slice(0, -1)) : p === type));
}

export function severityAtLeast(severity: Severity, minimum: Severity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(minimum);
}

/** Every operator present in a condition must hold (absent operators are ignored). */
const CHECKS: ReadonlyArray<(value: unknown, c: Condition) => boolean> = [
  (v, c) => c.exists === undefined || (v !== undefined && v !== null) === c.exists,
  (v, c) => c.equals === undefined || deepEqual(v, c.equals),
  (v, c) => c.in === undefined || c.in.some((option) => deepEqual(v, option)),
  (v, c) => c.contains === undefined || contains(v, c.contains),
  (v, c) => c.matches === undefined || safeRegex(c.matches).test(String(v ?? '')),
  (v, c) => c.gte === undefined || (typeof v === 'number' && v >= c.gte),
  (v, c) => c.lte === undefined || (typeof v === 'number' && v <= c.lte),
];

export function conditionHolds(value: unknown, condition: Condition): boolean {
  return CHECKS.every((check) => check(value, condition));
}

export function ruleMatches(match: RuleMatch, ctx: RuleContext): boolean {
  if (match.source && !match.source.includes(ctx.source)) return false;
  if (match.type && !typeMatches(match.type, ctx.type)) return false;
  if (match.minSeverity && !severityAtLeast(ctx.severity, match.minSeverity)) return false;
  return Object.entries(match.where).every(([path, condition]) =>
    conditionHolds(lookup(ctx, path), condition),
  );
}

function contains(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => item === needle);
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Regexes come from validated config; an invalid one simply never matches. */
function safeRegex(source: string): RegExp {
  try {
    return new RegExp(source);
  } catch {
    return /$^/;
  }
}
