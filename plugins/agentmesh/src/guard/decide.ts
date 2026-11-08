// Built-ins only: the worktree guard bundle (dist/guard.js) imports this. What the guard says about
// one PreToolUse call. In the mesh window it fails closed: a call it can't read, a tool it doesn't
// know and an edit with no file are refused, and a command it can't check asks. It never allows:
// silence hands the call to Claude Code's permission rules (in auto mode, its classifier). Every
// deny and ask carries the reason code the timeline records (a constant, never anything the call
// carried). The live `permission_mode` of the call decides auto mode, not the policy's `mode`, so a
// human who switches with Shift+Tab gets that mode's rules.
import type { WindowPolicy } from '@agentmesh/common/window';
import type { ReasonCode } from '@agentmesh/protocol/observe-codes';
import { checkoutTop, freeSlot, remoteRefExists } from './checkout';
import { type CommandContext, classifyCommand, UNLISTED } from './commands';
import { editTarget, meshWorktreeOf, type PathOptions } from './paths';
import { inForeignWorktree, searchStaysInWorktree } from './places';
import { recursiveSearch, risky } from './risky';
import { secretUse } from './secrets';
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
const SECRET =
  'mesh window: secrets and personal data are never read, printed or sent from here, in any mode; ask your human to do it themselves (if this is a commit message, PR text or search pattern, reword it, or use the Grep tool)';
const RISKY =
  'mesh window: this command can push, merge, rewrite or delete work, or reach infrastructure, so your human decides even in auto mode';
const SEARCH =
  'mesh window: a recursive search outside a task worktree can read untracked secrets, so your human decides; search with the Grep tool or git grep';
const SHELLS = ['Bash', 'PowerShell', 'Monitor'];

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

/** The command list's context, with the production readers on the same path options. */
const commandContext = (cwd: unknown, ctx: GuardContext, o: PathOptions): CommandContext => ({
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

/** Auto mode, for a command off the list: the risky floor, a recursive search outside a mesh
 * worktree and a teammate's worktree ask; anything else goes to auto mode's checks. */
function toAuto(command: string, c: CommandContext, p: WindowPolicy): GuardDecision {
  if (risky(command, p)) return ask(RISKY, 'command.risky');
  if (recursiveSearch(command) && !searchStaysInWorktree(command, c)) {
    return ask(SEARCH, 'command.risky');
  }
  const theirs = inForeignWorktree(command, c);
  return theirs ? ask(theirs.ask, theirs.code) : PASS;
}

/** Bash, PowerShell and Monitor. Secrets are refused in every mode, before the command list. Then
 * Bash goes through the list, and PowerShell and Monitor ask; in auto mode (with a policy and a
 * cwd) what would ask only for being off the list goes to `toAuto`. Anything that throws asks:
 * never pass, never crash the hook. */
function shell(
  tool: string,
  args: Record<string, unknown>,
  cwd: unknown,
  ctx: GuardContext,
  o: PathOptions,
  live: unknown,
): GuardDecision {
  try {
    const command = args.command;
    const secret = typeof command === 'string' ? secretUse(command) : null;
    if (secret) return deny(SECRET, secret);
    const p = ctx.policy;
    const auto =
      live === 'auto' && p !== null && typeof command === 'string' && typeof cwd === 'string';
    const c = commandContext(cwd, ctx, o);
    if (tool === 'Bash') {
      const d = classifyCommand(command as string, c);
      if (!('ask' in d)) return PASS;
      if (!auto || d.code !== 'command.not_listed') return ask(d.ask, d.code);
    } else if (!auto) {
      return ask(
        `mesh window: ${tool} commands need your human's approval here`,
        'command.needs_approval',
      );
    }
    return toAuto(command as string, c, p as WindowPolicy);
  } catch {
    return ask(UNLISTED, 'guard.error');
  }
}

export function decide(input: unknown, ctx: GuardContext): GuardDecision {
  if (!ctx.marked) return PASS;
  if (!isObject(input)) return deny(UNREADABLE, 'guard.unreadable');
  const { tool_name: tool, tool_input: args, cwd, permission_mode: live } = input;
  if (typeof tool !== 'string' || !isObject(args)) return deny(UNREADABLE, 'guard.unreadable');
  const o: PathOptions = { home: ctx.home, platform: ctx.platform };
  if (FILE_TOOLS.includes(tool)) return edit(args, o);
  if (SHELLS.includes(tool)) return shell(tool, args, cwd, ctx, o, live);
  // A plain subagent's own tool calls come back through this guard; an isolated one runs as a cloud
  // agent outside every local hook, or in a worktree Claude Code makes without asking.
  if (tool === 'Agent') return 'isolation' in args ? deny(ISOLATED, 'tool.agent_isolated') : PASS;
  if (tool === 'SendMessage') return sendMessage(args, ctx);
  const unknown = `mesh window: the guard does not know ${tool}, so it is refused`;
  return FIXED.get(tool) ?? deny(unknown, 'tool.unknown');
}
