import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { RpcRequestEnvelope } from './envelope';
import { RPC_METHODS } from './index';

interface LooseDef {
  type: string;
  checks?: Array<{ _zod: { def: { check?: string; format?: string } } }>;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  options?: z.ZodType[];
  innerType?: z.ZodType;
  in?: z.ZodType;
}

/** What a schema contains (object fields, array items) or wraps (optional, default, union, pipe). */
function children(def: LooseDef, path: string): Array<[z.ZodType, string]> {
  if (def.shape) return Object.entries(def.shape).map(([key, value]) => [value, `${path}.${key}`]);
  if (def.element) return [[def.element, `${path}[]`]];
  const wrapped = def.options ?? [def.innerType ?? def.in];
  return wrapped.flatMap((s): Array<[z.ZodType, string]> => (s ? [[s, path]] : []));
}

/** Paths of strings and arrays without a maximum; an (anchored) regex bounds a string too. */
function unbounded(schema: z.ZodType, path: string, out: string[] = []): string[] {
  const def = schema._zod.def as unknown as LooseDef;
  const checks = (def.checks ?? []).map((c) => c._zod.def);
  const capped =
    checks.some((c) => c.check === 'max_length') ||
    (def.type === 'string' && checks.some((c) => c.format === 'regex'));
  if ((def.type === 'string' || def.type === 'array') && !capped) out.push(path);
  for (const [child, at] of children(def, path)) unbounded(child, at, out);
  return out;
}

describe('RPC params caps', () => {
  it('caps every string and array a caller can send', () => {
    const found = Object.entries(RPC_METHODS).flatMap(([name, def]) => unbounded(def.params, name));
    found.push(...unbounded(RpcRequestEnvelope.omit({ params: true }), 'envelope'));
    expect(found).toEqual([]);
  });

  it('refuses a session.hello that would carry megabytes into the hub', () => {
    const hello = RPC_METHODS['session.hello'].params;
    const ok = { clientVersion: '0.4.0', repo: 'acme/api', branch: 'agent/x/task-1-y' };
    expect(hello.safeParse(ok).success).toBe(true);
    expect(hello.safeParse({ ...ok, previousSessionId: 's-abcdefghijkl' }).success).toBe(true);
    expect(hello.safeParse({ ...ok, meshWindow: true }).success).toBe(true);
    expect(hello.safeParse({ ...ok, meshWindow: 'yes' }).success).toBe(false);
    const huge = '1.'.repeat(500_000);
    expect(hello.safeParse({ ...ok, clientVersion: huge }).success).toBe(false);
    expect(hello.safeParse({ ...ok, repo: 'r'.repeat(301) }).success).toBe(false);
    expect(hello.safeParse({ ...ok, branch: 'b'.repeat(301) }).success).toBe(false);
    expect(hello.safeParse({ ...ok, previousSessionId: 'x'.repeat(65) }).success).toBe(false);
  });

  it('takes every branch and repo a caller names as a one-line GitRef', () => {
    const act = RPC_METHODS['task.act'].params;
    const review = RPC_METHODS['review.request'].params;
    const send = RPC_METHODS['message.send'].params;
    const cases: Array<[z.ZodType, Record<string, unknown>, string]> = [
      [act, { taskId: 'task-1', action: 'submit' }, 'branch'],
      [review, { prUrl: 'https://x/pr/1' }, 'branch'],
      [send, { kind: 'ask', body: 'hi', to: ['bob-agent'] }, 'repo'],
    ];
    for (const [schema, base, field] of cases) {
      const ok = (v: string) => schema.safeParse({ ...base, [field]: v }).success;
      expect([field, ok('agent/bob/task-1-x'), ok('a'.repeat(300))]).toEqual([field, true, true]);
      expect([field, ok('a\nb'), ok('a b'), ok('a'.repeat(301))]).toEqual([
        field,
        false,
        false,
        false,
      ]);
    }
  });
});
