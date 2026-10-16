import pino from 'pino';

export type Logger = pino.Logger;

export interface LoggerOptions {
  level?: string;
  /**
   * Where logs go. The channel plugin MUST use `stderr` (or a file), because
   * stdout carries the MCP stdio protocol.
   */
  destination?: 'stdout' | 'stderr' | { file: string };
}

export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const level = options.level ?? process.env.AGENTMESH_LOG_LEVEL ?? 'info';
  const destination = options.destination ?? 'stdout';
  const stream =
    destination === 'stdout'
      ? pino.destination(1)
      : destination === 'stderr'
        ? pino.destination(2)
        : pino.destination({ dest: destination.file, mkdir: true, sync: false });
  return pino({ name, level, base: { component: name } }, stream);
}
