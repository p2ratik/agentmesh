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
  it('inbox says how many team threads wait for an active session', async () => {
    const { deps } = fakeHub({ 'inbox.get': { ...base, waiting: 2 } });
    expect(text(await callTool('inbox', {}, deps))).toBe(
      '(2 team thread(s) are waiting for an active session. This session is not activated, so it cannot take them.)',
    );
  });

  it('inbox says when the mesh is paused', async () => {
    const { deps } = fakeHub({
      'inbox.get': { ...base, threads: [unreadThread], waiting: 0, paused: true },
    });
    const out = text(await callTool('inbox', {}, deps));
    expect(out.endsWith('(The mesh is paused: nothing was marked read.)')).toBe(true);
  });

  it('inbox is zero only with no threads, no other sessions and nothing waiting', async () => {
    const { deps } = fakeHub({ 'inbox.get': { ...base, waiting: 0 } });
    expect(text(await callTool('inbox', {}, deps))).toBe('Inbox zero — nothing unread.');
  });
});
