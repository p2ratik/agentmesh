// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. What the guard says about
// one PreToolUse call. In the mesh window it fails closed: a call it can't read, a tool it doesn't
// know and an edit with no file are refused, and a command it can't check asks. It never allows:
// silence hands the call to Claude Code's permission rules. Every deny and ask carries the reason
// code the timeline records (a constant, never anything the call carried).
import type { WindowPolicy } from '@agentmesh/common/window';
import type { ReasonCode } from '@agentmesh/protocol/observe-codes';
import { checkoutTop, freeSlot, remoteRefExists } from './checkout';
import { classifyCommand, UNLISTED } from './commands';
import { editTarget, meshWorktreeOf, type PathOptions } from './paths';
import { type ForwardReader, LIST_AGENTS, sendMessage } from './send';

export const ACTIVATE_TOOL = 'mcp__plugin_agentmesh_mesh__activate';
export const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

export interface GuardContext {
  marked: boolean;
  policy: WindowPolicy | null;
  home: string;
  platform: NodeJS.Platform;
  /** The window's forward records; without them every SendMessage is refused. */
  forwards?: ForwardReader;
  now?: number;
}

export type GuardDecision =
  /** `claimed`: the forward record a SendMessage used up, for the relay's timeline. */
  | { kind: 'pass'; claimed?: { message: string; thread: string } }
  | { kind: 'stamp' }
  /** `key`: an unknown SendMessage key, only when it is a plain identifier. */
  | { kind: 'deny'; reason: string; code: ReasonCode; key?: string }
  | { kind: 'ask'; reason: string; code: ReasonCode };

const PASS: GuardDecision = { kind: 'pass' };
const deny = (reason: string, code: ReasonCode): GuardDecision => ({ kind: 'deny', reason, code });
const ask = (reason: string, code: ReasonCode): GuardDecision => ({ kind: 'ask', reason, code });

const UNREADABLE = 'mesh window: the guard could not read this tool call, so it is refused';
const NO_FILE = 'mesh window: this edit names no file, so it is refused';
const ENTER =
  'mesh window: stay in this folder; make worktrees with git worktree add .claude/worktrees/mesh-…';
const ISOLATED =
  'mesh window: subagents run here, without isolation; worktrees are made with git worktree add .claude/worktrees/mesh-…';
const WORKFLOW = "mesh window: workflows need your human's approval here";

/** Tools the window answers the same way every time (a Map: a tool name can't hit a prototype). */
const FIXED = new Map<string, GuardDecision>([
  [ACTIVATE_TOOL, { kind: 'stamp' }],
  ['EnterWorktree', deny(ENTER, 'tool.enter_worktree')],
  ['Workflow', ask(WORKFLOW, 'tool.workflow')],
  ['ListAgents', deny(LIST_AGENTS, 'list_agents')],
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every path the edit names must be a writable worktree path: the tools read different fields
 * (NotebookEdit `notebook_path`, the others `file_path`), so a second one can't ride past. */
function edit(args: Record<string, unknown>, o: PathOptions): GuardDecision {
  const paths = [args.notebook_path, args.file_path].filter((p) => p !== undefined && p !== null);
  if (paths.length === 0 || paths.includes('')) return deny(NO_FILE, 'path.no_file');
  for (const path of paths) {
    const target = editTarget(path as string, o);
    if ('refused' in target) {
      const reason = `mesh window: work only inside a task worktree (${target.refused})`;
      return deny(reason, target.code);
    }
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
    return 'ask' in d ? ask(d.ask, d.code) : PASS;
  } catch {
    return ask(UNLISTED, 'guard.error');
  }
}

export function decide(input: unknown, ctx: GuardContext): GuardDecision {
  if (!ctx.marked) return PASS;
  if (!isObject(input)) return deny(UNREADABLE, 'guard.unreadable');
  const { tool_name: tool, tool_input: args, cwd } = input;
  if (typeof tool !== 'string' || !isObject(args)) return deny(UNREADABLE, 'guard.unreadable');
  const o: PathOptions = { home: ctx.home, platform: ctx.platform };
  if (FILE_TOOLS.includes(tool)) return edit(args, o);
  if (tool === 'Bash') return bash(args.command, cwd, ctx, o);
  if (tool === 'PowerShell' || tool === 'Monitor') {
    const reason = `mesh window: ${tool} commands need your human's approval here`;
    return ask(reason, 'command.needs_approval');
  }
  // A plain subagent's own tool calls come back through this guard; an isolated one runs as a cloud
  // agent outside every local hook, or in a worktree Claude Code makes without asking.
  if (tool === 'Agent') return 'isolation' in args ? deny(ISOLATED, 'tool.agent_isolated') : PASS;
  if (tool === 'SendMessage') return sendMessage(args, ctx);
  const unknown = `mesh window: the guard does not know ${tool}, so it is refused`;
  return FIXED.get(tool) ?? deny(unknown, 'tool.unknown');
}
