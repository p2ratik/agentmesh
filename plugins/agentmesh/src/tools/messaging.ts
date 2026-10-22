import { z } from 'zod';
import { firstLine } from '../inbox/fyi';
import { formatPeers, formatThread, formatThreadHeader } from './format';
import { defineTool, withKey } from './types';

const Status = z.enum([
  'answer',
  'accepted',
  'declined',
  'working',
  'blocked',
  'done',
  'needs_human',
  'info',
]);
const OneOrMany = z.union([z.string(), z.array(z.string()).min(1)]);
const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

export const messagingTools = [
  defineTool({
    name: 'peers',
    description:
      'List teammates (agents and humans) with presence, load, skills and owned areas. Use before asking or assigning.',
    input: z.object({ kind: z.enum(['agent', 'human', 'all']).optional() }),
    mutating: false,
    run: async (args, { hub }) =>
      formatPeers((await hub.call('peers.list', { kind: args.kind ?? 'all' })).peers),
  }),
  defineTool({
    name: 'set_status',
    description:
      'Tell the team whether you are online, busy (deep in a task) or away, with an optional note.',
    input: z.object({
      status: z.enum(['online', 'busy', 'away']),
      note: z.string().max(200).optional(),
    }),
    mutating: false,
    run: async (args, { hub }) => {
      const peer = await hub.call('presence.set', {
        status: args.status,
        ...(args.note ? { note: args.note } : {}),
      });
      return `Status set to ${peer.status}${peer.statusNote ? ` (${peer.statusNote})` : ''}.`;
    },
  }),
  defineTool({
    name: 'ask',
    description:
      'Start a new thread with one or more teammates (agent or human ids, or "@all" / "@online"). The answer arrives later as a channel event. Pass parent_thread_id when this question comes from work in another thread. To one agent, pass to_session (a session id from peers) to pick the session it fits, or repo (owner/name) for the repo it is about.',
    input: z.object({
      to: OneOrMany,
      text: z.string().min(1),
      subject: z.string().max(200).optional(),
      parent_thread_id: z.string().optional(),
      to_session: z.string().optional(),
      repo: z.string().max(200).optional(),
    }),
    mutating: true,
    run: async (args, { hub }, key) => {
      const r = await hub.call(
        'message.send',
        {
          kind: 'ask',
          to: list(args.to),
          body: args.text,
          ...(args.subject ? { subject: args.subject } : {}),
          ...(args.parent_thread_id ? { parentThreadId: args.parent_thread_id } : {}),
          ...(args.to_session ? { toSession: args.to_session } : {}),
          ...(args.repo ? { repo: args.repo } : {}),
        },
        withKey(key),
      );
      return `Asked ${r.deliveredTo.join(', ') || 'nobody'} in ${r.threadId} (${r.messageId})${r.held ? ' — mesh is paused, delivery held' : ''}.`;
    },
  }),
  defineTool({
    name: 'reply',
    description:
      'Post into an existing thread (everyone in it receives it). Use the thread_id from the channel tag.',
    input: z.object({
      thread_id: z.string(),
      text: z.string().min(1),
      status: Status.optional(),
      pr_url: z.string().optional(),
    }),
    mutating: true,
    run: async (args, { hub }, key) => {
      const r = await hub.call(
        'message.send',
        {
          kind: 'reply',
          threadId: args.thread_id,
          body: args.text,
          ...(args.status ? { status: args.status } : {}),
          ...(args.pr_url ? { prUrl: args.pr_url } : {}),
        },
        withKey(key),
      );
      return `Replied in ${r.threadId} to ${r.deliveredTo.join(', ') || 'no agents'} (${r.messageId}).`;
    },
  }),
  defineTool({
    name: 'broadcast',
    description:
      'Announce something to several teammates at once (default: every agent). Use sparingly — it costs everyone a turn.',
    input: z.object({
      text: z.string().min(1),
      to: OneOrMany.optional(),
      subject: z.string().max(200).optional(),
    }),
    mutating: true,
    run: async (args, { hub }, key) => {
      const r = await hub.call(
        'message.send',
        {
          kind: 'broadcast',
          to: args.to ? list(args.to) : ['@all'],
          body: args.text,
          ...(args.subject ? { subject: args.subject } : {}),
        },
        withKey(key),
      );
      return `Broadcast to ${r.deliveredTo.length} agent(s) in ${r.threadId}.`;
    },
  }),
  defineTool({
    name: 'inbox',
    description:
      'Unread messages from every thread you are in: threads that need you first, then FYI (status only); marks them read. Once this session is active, call it at session start and after compaction.',
    input: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    mutating: false,
    run: async (args, { hub }) => {
      const r = await hub.call('inbox.get', { limit: args.limit ?? 10, perThread: 5 });
      const others = r.otherSessions;
      if (r.threads.length === 0 && others.length === 0) return 'Inbox zero — nothing unread.';
      const needs = r.threads
        .filter((t) => !t.fyi)
        .map((t) => `${t.unread} unread · ${formatThread(t.thread, t.messages)}`);
      const fyi = r.threads
        .filter((t) => t.fyi)
        .map((t) => {
          const latest = firstLine(t.messages.at(-1)?.body ?? '', 100);
          return `· ${t.unread} unread · ${formatThreadHeader(t.thread)} — ${latest}`;
        });
      const parts: string[] = [];
      if (needs.length > 0) parts.push(`Needs you:\n${needs.join('\n\n====\n\n')}`);
      if (fyi.length > 0) parts.push(`FYI:\n${fyi.join('\n')}`);
      if (r.remainingThreads > 0)
        parts.push(`(${r.remainingThreads} more thread(s) unread — call inbox again)`);
      if (others.length > 0) {
        const owned = others.map((o) => `${o.threadId} (${o.sessionId}, ${o.liveness})`);
        parts.push(
          `(${others.length} unread thread(s) belong to your other sessions: ${owned.join(', ')})`,
        );
      }
      return parts.join('\n\n====\n\n');
    },
  }),
  defineTool({
    name: 'thread',
    description:
      'Read a thread (most recent messages). Use it instead of re-asking after a compaction.',
    input: z.object({ thread_id: z.string(), limit: z.number().int().min(1).max(200).optional() }),
    mutating: false,
    run: async (args, { hub }) => {
      const r = await hub.call('thread.get', { threadId: args.thread_id, limit: args.limit ?? 30 });
      return formatThread(r.thread, r.messages);
    },
  }),
  defineTool({
    name: 'escalate',
    description:
      'Ask a human (your owner by default) — they are pinged in Discord. Use before risky or irreversible actions (merging to protected branches, infra, secrets).',
    input: z.object({
      question: z.string().min(1),
      to: z.string().optional(),
      thread_id: z.string().optional(),
      task_id: z.string().optional(),
      urgent: z.boolean().optional(),
    }),
    mutating: true,
    run: async (args, { hub }, key) => {
      const r = await hub.call(
        'escalate',
        {
          question: args.question,
          ...(args.to ? { to: args.to } : {}),
          ...(args.thread_id ? { threadId: args.thread_id } : {}),
          ...(args.task_id ? { taskId: args.task_id } : {}),
          urgent: args.urgent ?? false,
        },
        withKey(key),
      );
      return `Escalated in ${r.threadId}; the answer will arrive as a channel event.`;
    },
  }),
];
