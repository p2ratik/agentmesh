import { isAbsolute, resolve } from 'node:path';
import type { RunProcess } from './lib/process';
import type { ConnectNats } from './setup/checks/agent';
import type { CheckResult } from './setup/checks/result';

/**
 * Everything a command touches outside its arguments. `main.ts` builds it
 * from the real process; tests pass temp directories and capture output.
 */
export interface CliContext {
  /** Directory relative paths resolve against. */
  cwd: string;
  env: Record<string, string | undefined>;
  homeDir: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /** HTTP for commands that call out (Discord); defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Waits between polls; tests resolve at once. */
  sleep?: (ms: number) => Promise<void>;
  /** Runs ssh, scp and docker; defaults to `runProcess`. */
  run?: RunProcess;
  /** Resolves a host name to its addresses; defaults to the system resolver. */
  lookup?: (host: string) => Promise<string[]>;
  /** Opens one NATS connection with a seed file; defaults to `connectOnce`. */
  connectNats?: ConnectNats;
  /** Checks the certificate NATS presents; defaults to `checkNatsTls`. */
  probeNatsTls?: (host: string, port: number, now: Date) => Promise<CheckResult>;
}

/** One `agentmesh` subcommand. `name` may have two words (`keys add`). */
export interface Command {
  name: string;
  summary: string;
  help: string;
  run(argv: string[], ctx: CliContext): Promise<number> | number;
}

export function resolveFrom(ctx: CliContext, path: string): string {
  return isAbsolute(path) ? path : resolve(ctx.cwd, path);
}

/** The config directory: `--config`, else `$AGENTMESH_CONFIG`, else the current directory. */
export function configPathFrom(ctx: CliContext, flag: string | undefined): string {
  return resolveFrom(ctx, flag ?? ctx.env.AGENTMESH_CONFIG ?? '.');
}
