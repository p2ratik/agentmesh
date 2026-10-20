import type { ChatInputCommandInteraction } from 'discord.js';
import type { ChannelDirectory } from '../discord/directory';
import type { HumanCall } from '../rpc';
import { runInvite, runRemove, runUninvite } from './enrollment';
import {
  askParams,
  planStartParams,
  taskAssignParams,
  taskCancelParams,
  taskCreateParams,
  taskListParams,
} from './params';
import {
  asked,
  meshStatus,
  planStarted,
  planStatus,
  taskCreated,
  taskDetail,
  taskLines,
} from './replies';

export interface CommandContext {
  directory: ChannelDirectory;
  /** Reloads open invites for autocomplete; logs instead of throwing. */
  refreshInvites(): Promise<void>;
}

/** Runs one slash command for an authorized human; returns the reply text. */
export type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  call: HumanCall,
  ctx: CommandContext,
) => Promise<string>;

const opt = (i: ChatInputCommandInteraction, name: string) => i.options.getString(name);
const req = (i: ChatInputCommandInteraction, name: string) => i.options.getString(name, true);

/** Keyed by `command.subcommand` (`ask.` for commands without subcommands). */
export const COMMAND_HANDLERS: Readonly<Record<string, CommandHandler>> = {
  'plan.start': async (i, call, ctx) => {
    const params = planStartParams({
      topic: req(i, 'topic'),
      participants: opt(i, 'participants'),
      facilitator: opt(i, 'facilitator'),
      minutes: i.options.getInteger('minutes'),
    });
    return planStarted(await call('plan.start', params), ctx.directory.channelFor('planning'));
  },
  'plan.status': async (i, call) =>
    planStatus((await call('plan.get', { planId: req(i, 'plan') })).plan),
  'plan.approve': async (i, call) =>
    `✅ ${planStatus(await call('plan.approve', { planId: req(i, 'plan') }))}`,
  'plan.cancel': async (i, call) => {
    const reason = opt(i, 'reason');
    const plan = await call('plan.cancel', {
      planId: req(i, 'plan'),
      ...(reason ? { reason } : {}),
    });
    return `🛑 ${planStatus(plan)}`;
  },
  'task.create': async (i, call) =>
    taskCreated(
      await call(
        'task.create',
        taskCreateParams({
          title: req(i, 'title'),
          description: opt(i, 'description'),
          area: opt(i, 'area'),
          repo: opt(i, 'repo'),
          assignee: opt(i, 'assignee'),
          priority: opt(i, 'priority'),
        }),
      ),
    ),
  'task.list': async (i, call) =>
    taskLines(
      (
        await call(
          'task.list',
          taskListParams({ assignee: opt(i, 'assignee'), state: opt(i, 'state') }),
        )
      ).tasks,
    ),
  'task.show': async (i, call) => taskDetail(await call('task.get', { taskId: req(i, 'task') })),
  'task.assign': async (i, call) =>
    taskCreated(await call('task.act', taskAssignParams(req(i, 'task'), req(i, 'agent')))),
  'task.cancel': async (i, call) => {
    const task = await call('task.act', taskCancelParams(req(i, 'task'), opt(i, 'reason')));
    return `🛑 **${task.id}** is ${task.state}.`;
  },
  'ask.': async (i, call, ctx) => {
    const agent = req(i, 'agent');
    const result = await call('message.send', askParams(agent, req(i, 'question')));
    return asked(agent, result.threadId, ctx.directory.channelFor('council'));
  },
  'mesh.status': async (_i, call) => meshStatus(await call('mesh.status', {})),
  'mesh.invite': async (i, call, ctx) => {
    const text = await runInvite(i, call);
    await ctx.refreshInvites();
    return text;
  },
  'mesh.uninvite': async (i, call, ctx) => {
    const text = await runUninvite(i, call);
    await ctx.refreshInvites();
    return text;
  },
  'mesh.remove': (i, call) => runRemove(i, call),
  'mesh.pause': async (i, call) => {
    const reason = opt(i, 'reason');
    await call('mesh.pause', reason ? { reason } : {});
    return '⏸️ Mesh paused — deliveries to agents are held until `/mesh resume`.';
  },
  'mesh.resume': async (_i, call) => {
    const { released } = await call('mesh.resume', {});
    return `▶️ Mesh resumed — released ${released} held deliver${released === 1 ? 'y' : 'ies'}.`;
  },
};
