import { homedir } from 'node:os';
import type { Interface } from 'node:readline/promises';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { expandHome, isMeshError } from '@agentmesh/common';
import { deleteInviteFile, readInviteFile } from './files';
import { type JoinOutcome, runJoin } from './flow';
import { confirmationText } from './invite';

const USAGE = `Usage: node <plugin>/dist/server.js join [--file <invite-file>] [--yes] [--replace]

Joins an AgentMesh from a terminal, so the invite code never enters a chat.
Without --file it asks you to paste the code. It shows which hub the invite
points at and asks before connecting (--yes skips that). --replace switches a
laptop that is already set up for another mesh.`;

interface JoinArgs {
  file?: string | undefined;
  yes?: boolean | undefined;
  replace?: boolean | undefined;
  help?: boolean | undefined;
}

function parseJoinArgs(argv: string[]): JoinArgs | string {
  try {
    return parseArgs({
      args: argv,
      options: {
        file: { type: 'string' },
        yes: { type: 'boolean' },
        replace: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function joinedText(done: Extract<JoinOutcome, { kind: 'joined' }>): string {
  const { agentId, natsUrl } = done.summary.payload;
  return [
    `Joined "${done.hello.mesh.name}" as ${done.hello.self.id}.`,
    `  key       ${done.saved.seedFile} (generated here, private)`,
    `  settings  ${done.saved.configFile}`,
    '',
    'Start Claude Code with the mesh channel:',
    '  claude --dangerously-load-development-channels plugin:agentmesh@agentmesh',
    `If Claude Code asks for the plugin options, enter agent_id ${agentId} and nats_url ${natsUrl}; leave the rest empty.`,
    '',
  ].join('\n');
}

async function confirmed(rl: Interface, hub: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  const answer = await rl.question(`Is ${hub} your team's hub? [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * `server.js join`: the terminal path for invites. Also the fallback when
 * Claude Code will not start an unconfigured plugin. Returns the exit code.
 */
export async function runJoinCli(argv: string[], clientVersion: string): Promise<number> {
  const args = parseJoinArgs(argv);
  if (typeof args === 'string') {
    process.stderr.write(`${args}\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const file = args.file ? expandHome(args.file) : null;
    const code = file ? readInviteFile(file) : await rl.question('Paste your invite code: ');
    const request = { code, home: homedir(), clientVersion, replace: args.replace ?? false };
    const first = await runJoin(request);
    process.stdout.write(`${confirmationText(first.summary)}\n`);
    if (!(await confirmed(rl, first.summary.hub, args.yes ?? false))) {
      process.stdout.write('Not joined; nothing was sent.\n');
      return 1;
    }
    const done = await runJoin({ ...request, confirmedHub: first.summary.hub });
    if (done.kind !== 'joined') throw new Error('unexpected join state');
    if (file) deleteInviteFile(file);
    process.stdout.write(joinedText(done));
    return 0;
  } catch (error) {
    process.stderr.write(
      `${isMeshError(error) ? error.message : `join failed: ${String(error)}`}\n`,
    );
    return 1;
  } finally {
    rl.close();
  }
}
