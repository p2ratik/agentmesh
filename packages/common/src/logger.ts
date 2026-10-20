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

/** Fields that may hold invite codes or tokens are never written, at the top level or one deep. */
const SECRET_FIELDS = ['invite', 'inviteCode', 'secret', 'token', 'auth_token'];
export const REDACTED_LOG_PATHS = SECRET_FIELDS.flatMap((f) => [f, `*.${f}`]);

export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const level = options.level ?? process.env.AGENTMESH_LOG_LEVEL ?? 'info';
  const destination = options.destination ?? 'stdout';
  const stream =
    destination === 'stdout'
      ? pino.destination(1)
      : destination === 'stderr'
        ? pino.destination(2)
        : pino.destination({ dest: destination.file, mkdir: true, sync: false });
  return pino(
    {
      name,
      level,
      base: { component: name },
      redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' },
    },
    stream,
  );
}
