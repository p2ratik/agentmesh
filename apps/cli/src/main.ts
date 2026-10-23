import { homedir } from 'node:os';
import { isMeshError } from '@agentmesh/common';
import { agentSetupCommand } from './commands/agent-setup';
import { initCommand } from './commands/init';
import { keysAddCommand, keysListCommand } from './commands/keys';
import { natsConfigCommand } from './commands/nats-config';
import { setupDiscordCommand } from './commands/setup/discord';
import { setupHostCommand } from './commands/setup/host';
import { setupRenderCommand } from './commands/setup/render';
import { setupStatusCommand } from './commands/setup/status';
import { validateCommand } from './commands/validate';
import type { CliContext, Command } from './context';

export const COMMANDS: readonly Command[] = [
  initCommand,
  validateCommand,
  keysAddCommand,
  keysListCommand,
  natsConfigCommand,
  agentSetupCommand,
  setupRenderCommand,
  setupDiscordCommand,
  setupHostCommand,
  setupStatusCommand,
];

function usage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
  return [
    'agentmesh — set up and manage an AgentMesh',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}${c.summary}`),
    '',
    'Run `agentmesh <command> --help` for details.',
  ].join('\n');
}

/** Finds the command for argv (two-word names like `keys add` first). */
export function matchCommand(argv: readonly string[]): { command: Command; rest: string[] } | null {
  for (const words of [2, 1]) {
    const name = argv.slice(0, words).join(' ');
    const command = COMMANDS.find((c) => c.name === name);
    if (command) return { command, rest: argv.slice(words) };
  }
  return null;
}

/** Runs the CLI; returns the exit code (0 ok, 1 failure, 2 usage error). */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout(usage());
    return argv.length === 0 ? 2 : 0;
  }
  const match = matchCommand(argv);
  if (!match) {
    ctx.stderr(`Unknown command "${argv.join(' ')}".\n\n${usage()}`);
    return 2;
  }
  if (match.rest.includes('--help') || match.rest.includes('-h')) {
    ctx.stdout(match.command.help);
    return 0;
  }
  try {
    return await match.command.run(match.rest, ctx);
  } catch (error) {
    if (isMeshError(error)) {
      ctx.stderr(`error: ${error.message}`);
      return error.code === 'invalid_request' ? 2 : 1;
    }
    ctx.stderr(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isEntry = process.argv[1] && /main\.(ts|js)$/.test(process.argv[1]);
if (isEntry) {
  const ctx: CliContext = {
    // `pnpm mesh …` runs inside apps/cli; INIT_CWD is where the user typed it.
    cwd: process.env.INIT_CWD ?? process.cwd(),
    env: process.env,
    homeDir: homedir(),
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  };
  runCli(process.argv.slice(2), ctx).then((code) => process.exit(code));
}
