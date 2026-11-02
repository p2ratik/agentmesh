import { describe, expect, it } from 'vitest';
import { fakeHub, text } from './fake-hub';
import { callTool } from './registry';

const base = { threads: [], remainingThreads: 0, otherSessions: [] };

const unreadThread = {
  thread: {
    id: 'thr-1',
    kind: 'conversation',
    subject: 'Login',
    createdBy: 'bob-agent',
    createdAt: '2026-10-22T08:00:00.000Z',
    updatedAt: '2026-10-22T09:00:00.000Z',
    depth: 0,
    parentId: null,
    participants: ['alice-agent', 'bob-agent'],
    taskId: null,
    planId: null,
    status: 'open',
    messageCount: 1,
  },
  unread: 1,
  messages: [],
  fyi: true,
};

describe('inbox tool', () => {
  it('prints the hub note, not its own line, when team threads are waiting', async () => {
    const note =
      "2 team thread(s) are waiting for an active session of this agent; this session can't take them right now.";
    const { deps } = fakeHub({ 'inbox.get': { ...base, waiting: 2 } }, { 'inbox.get': [note] });
    const result = await callTool('inbox', {}, deps);
    const all = result.content.map((c) => c.text).join('\n');
    expect(all).not.toContain('Inbox zero');
    expect(all.split(note)).toHaveLength(2);
    expect(all).not.toContain('not activated');
  });

  it('does not print its own paused line (the hub note carries it)', async () => {
    const { deps } = fakeHub({
      'inbox.get': { ...base, threads: [unreadThread], waiting: 0, paused: true },
    });
    expect(text(await callTool('inbox', {}, deps))).not.toContain('paused');
  });

  it('inbox is zero only with no threads, no other sessions and nothing waiting', async () => {
    const { deps } = fakeHub({ 'inbox.get': { ...base, waiting: 0 } });
    expect(text(await callTool('inbox', {}, deps))).toBe('Inbox zero — nothing unread.');
  });
});
