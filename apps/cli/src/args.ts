import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import { MeshError } from '@agentmesh/common';

/** A usage mistake: the CLI prints it with a hint and exits with code 2. */
export const usageError = (message: string): MeshError => new MeshError('invalid_request', message);

/**
 * Strict `node:util` parsing with a positional-count check. Unknown flags and
 * missing values become usage errors instead of stack traces.
 */
export function parseCommandArgs<const O extends ParseArgsOptionsConfig>(
  args: string[],
  options: O,
  positionals: { min: number; max: number; names: string },
) {
  let parsed: ReturnType<typeof parseArgs<{ options: O; allowPositionals: true; strict: true }>>;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw usageError((error as Error).message);
  }
  const count = parsed.positionals.length;
  if (count < positionals.min) throw usageError(`Missing argument: ${positionals.names}`);
  if (count > positionals.max) {
    throw usageError(`Unexpected argument "${parsed.positionals[positionals.max]}"`);
  }
  return parsed;
}
