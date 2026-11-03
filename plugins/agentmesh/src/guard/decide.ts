// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. What the guard says about
// one PreToolUse call. In the mesh window it fails closed: a call it can't read, a tool it doesn't
// know and an edit with no file are refused, and a command it can't check asks. It never allows:
// silence hands the call to Claude Code's permission rules.
import type { WindowPolicy } from '@agentmesh/common/window';
import { checkoutTop, freeSlot, remoteRefExists } from './checkout';
import { classifyCommand, UNLISTED } from './commands';
import { editTarget, meshWorktreeOf, type PathOptions } from './paths';

export const ACTIVATE_TOOL = 'mcp__plugin_agentmesh_mesh__activate';
export const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

export interface GuardContext {
  marked: boolean;
  policy: WindowPolicy | null;
  home: string;
  platform: NodeJS.Platform;
}

export type GuardDecision =
  | { kind: 'pass' }
  | { kind: 'stamp' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string };

const PASS: GuardDecision = { kind: 'pass' };
const deny = (reason: string): GuardDecision => ({ kind: 'deny', reason });
const ask = (reason: string): GuardDecision => ({ kind: 'ask', reason });

const UNREADABLE = 'mesh window: the guard could not read this tool call, so it is refused';
const NO_FILE = 'mesh window: this edit names no file, so it is refused';
const ENTER =
  'mesh window: stay in this folder; make worktrees with git worktree add .claude/worktrees/mesh-…';
const ISOLATED =
  'mesh window: subagents run here, without isolation; worktrees are made with git worktree add .claude/worktrees/mesh-…';
const WORKFLOW = "mesh window: workflows need your human's approval here";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every path the edit names must be a writable worktree path: the tools read different fields
 * (NotebookEdit `notebook_path`, the others `file_path`), so a second one can't ride past. */
function edit(args: Record<string, unknown>, o: PathOptions): GuardDecision {
  const paths = [args.notebook_path, args.file_path].filter((p) => p !== undefined && p !== null);
  if (paths.length === 0 || paths.includes('')) return deny(NO_FILE);
  for (const path of paths) {
    const target = editTarget(path as string, o);
    if ('refused' in target)
      return deny(`mesh window: work only inside a task worktree (${target.refused})`);
  }
  return PASS;
}

/** The command list, with the production readers on the same path options. A reader that throws
 * makes the command ask: never pass, never crash the hook. */
function bash(command: unknown, cwd: unknown, ctx: GuardContext, o: PathOptions): GuardDecision {
  try {
    const d = classifyCommand(command as string, {
      policy: ctx.policy,
      cwd: cwd as string,
      worktreeOf: (dir) => {
        const w = meshWorktreeOf(dir, o);
        return 'refused' in w ? null : w;
      },
      checkoutTop: (dir) => checkoutTop(dir, o),
      remoteRefExists: (top, branch) => remoteRefExists(top, branch, o),
      freeSlot: (top, name) => freeSlot(top, name, o),
    });
    return 'ask' in d ? ask(d.ask) : PASS;
  } catch {
    return ask(UNLISTED);
  }
}

export function decide(input: unknown, ctx: GuardContext): GuardDecision {
  if (!ctx.marked) return PASS;
  if (!isObject(input)) return deny(UNREADABLE);
  const { tool_name: tool, tool_input: args, cwd } = input;
  if (typeof tool !== 'string' || !isObject(args)) return deny(UNREADABLE);
  const o: PathOptions = { home: ctx.home, platform: ctx.platform };
  if (FILE_TOOLS.includes(tool)) return edit(args, o);
  if (tool === 'Bash') return bash(args.command, cwd, ctx, o);
  if (tool === 'PowerShell' || tool === 'Monitor') {
    return ask(`mesh window: ${tool} commands need your human's approval here`);
  }
  if (tool === 'EnterWorktree') return deny(ENTER);
  // A plain subagent's own tool calls come back through this guard; an isolated one runs as a cloud
  // agent outside every local hook, or in a worktree Claude Code makes without asking.
  if (tool === 'Agent') return 'isolation' in args ? deny(ISOLATED) : PASS;
  if (tool === 'Workflow') return ask(WORKFLOW);
  if (tool === ACTIVATE_TOOL) return { kind: 'stamp' };
  return deny(`mesh window: the guard does not know ${tool}, so it is refused`);
}
