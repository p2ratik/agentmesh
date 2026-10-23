import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeshError } from '@agentmesh/common';
import { z } from 'zod';
import { usageError } from '../args';
import { type CliContext, resolveFrom } from '../context';
import { writeFileAtomic, writeFileWithDirs } from '../lib/files';
import { parseAnswers, type SetupAnswers } from './answers';

/** Where everything lives in a setup workspace (§5.2 of the setup design). */
export interface WorkspacePaths {
  root: string;
  answers: string;
  state: string;
  configDir: string;
  meshFile: string;
  policyFile: string;
  deployDir: string;
  compose: string;
  envFile: string;
  natsConf: string;
  secretsDir: string;
  gitignore: string;
  claudeSettings: string;
  claudeMd: string;
}

/** `--dir` is required, so setup never writes into the current directory by accident. */
export function workspaceFrom(ctx: CliContext, dir: string | undefined): WorkspacePaths {
  if (!dir) throw usageError('Missing --dir <workspace>');
  return workspacePaths(resolveFrom(ctx, dir));
}

export function workspacePaths(root: string): WorkspacePaths {
  const configDir = join(root, 'config');
  const deployDir = join(root, 'deploy');
  return {
    root,
    answers: join(root, 'setup-answers.json'),
    state: join(root, '.agentmesh-setup.json'),
    configDir,
    meshFile: join(configDir, 'mesh.yaml'),
    policyFile: join(configDir, 'policy', 'team-policy.md'),
    deployDir,
    compose: join(deployDir, 'docker-compose.yml'),
    envFile: join(deployDir, '.env'),
    natsConf: join(deployDir, 'nats', 'nats.conf'),
    secretsDir: join(deployDir, 'secrets'),
    gitignore: join(root, '.gitignore'),
    claudeSettings: join(root, '.claude', 'settings.json'),
    claudeMd: join(root, 'CLAUDE.md'),
  };
}

/** The setup steps in order; the state file records when each one finished. */
export const STEPS = ['render', 'discord', 'host', 'deploy', 'admin'] as const;
export type StepName = (typeof STEPS)[number];

/** `.agentmesh-setup.json`: finished steps and their ISO times. It holds no secrets. */
export const SetupState = z.object({
  version: z.literal(1),
  done: z.partialRecord(z.enum(STEPS), z.string()),
});
export type SetupState = z.infer<typeof SetupState>;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new MeshError('invalid_request', `${path} is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

export function readState(p: WorkspacePaths): SetupState {
  if (!existsSync(p.state)) return { version: 1, done: {} };
  const parsed = SetupState.safeParse(readJson(p.state));
  if (parsed.success) return parsed.data;
  throw new MeshError('invalid_request', `Invalid ${p.state}:\n${z.prettifyError(parsed.error)}`);
}

export function markDone(p: WorkspacePaths, step: StepName, now: Date): void {
  const state = readState(p);
  state.done[step] = now.toISOString();
  writeFileAtomic(p.state, `${JSON.stringify(state, null, 2)}\n`);
}

export function loadAnswers(p: WorkspacePaths): SetupAnswers {
  if (!existsSync(p.answers)) {
    throw new MeshError('not_found', `No setup answers at ${p.answers}`);
  }
  return parseAnswers(readJson(p.answers));
}

export type WriteOutcome = 'created' | 'unchanged' | 'differs' | 'replaced';

/** Writes a rendered file, but replaces one whose content differs only with `force`. */
export function writeRendered(path: string, content: string, force: boolean): WriteOutcome {
  const exists = existsSync(path);
  if (exists && readFileSync(path, 'utf8') === content) return 'unchanged';
  if (exists && !force) return 'differs';
  writeFileWithDirs(path, content);
  return exists ? 'replaced' : 'created';
}
