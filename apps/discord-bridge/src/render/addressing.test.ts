import { ConfigIndex, configFromObject } from '@agentmesh/config';
import type { MeshMessage, ThreadSummary } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import { avatarFor, discordDefaultAvatar } from './avatars';
import { addressee, renderMessageCreated } from './message';

const index = new ConfigIndex(
  configFromObject({
    version: 1,
    mesh: { name: 'acme' },
    humans: [
      { id: 'pratik', displayName: 'Pratik' },
      { id: 'sagar', displayName: 'Sagar' },
      { id: 'aheen', displayName: 'Aheen' },
    ],
    agents: [
      { id: 'pratik-agent', owner: 'pratik' },
      { id: 'sagar-agent', owner: 'sagar' },
      { id: 'aheen-agent', owner: 'aheen', avatarUrl: 'https://github.com/aheen.png' },
    ],
  }).config,
);

const ref = (id: string) => ({ id, kind: 'agent' as const, displayName: index.displayName(id) });

const thread = (participants: string[]): ThreadSummary => ({
  id: 'thr-7',
  kind: 'conversation',
  subject: 'Render API status codes',
  createdBy: 'pratik-agent',
  createdAt: '',
  updatedAt: '',
  depth: 0,
  parentId: null,
  participants,
  taskId: null,
  planId: null,
  status: 'open',
  messageCount: 2,
});

const message = (from: string, to: string[], kind: MeshMessage['kind'] = 'reply'): MeshMessage => ({
  id: `msg-${from}`,
  threadId: 'thr-7',
  kind,
  from: ref(from),
  to,
  subject: 'Render API status codes',
  body: 'body',
  status: null,
  trust: 'team',
  depth: 0,
  refs: {},
  createdAt: '2026-10-16T09:00:00.000Z',
});

const trio = thread(['pratik-agent', 'sagar-agent', 'aheen-agent']);

describe('addressee', () => {
  it('always names who an ask is for', () => {
    const ask = message('pratik-agent', ['sagar-agent'], 'ask');
    expect(addressee(ask, thread(['pratik-agent', 'sagar-agent']), index)).toBe("→ Sagar's agent");
    const [intent] = renderMessageCreated({ message: ask, thread: trio }, index);
    expect(intent?.content.split('\n')[0]).toBe("**[ask]** → Sagar's agent");
  });

  it('names the recipient of a reply that reaches only part of the thread', () => {
    const targeted = message('sagar-agent', ['pratik-agent']);
    expect(addressee(targeted, trio, index)).toBe("→ Pratik's agent");
    const [intent] = renderMessageCreated({ message: targeted, thread: trio }, index);
    expect(intent?.content.split('\n')[0]).toBe("→ Pratik's agent");
  });

  it('stays quiet when a reply simply goes to everyone else', () => {
    const toAll = message('sagar-agent', ['pratik-agent', 'aheen-agent']);
    expect(addressee(toAll, trio, index)).toBe('');
    expect(addressee(message('sagar-agent', []), trio, index)).toBe('');
  });
});

describe('avatars', () => {
  it('gives every agent a distinct built-in avatar unless one is configured', () => {
    const pratik = avatarFor(ref('pratik-agent'), index);
    const sagar = avatarFor(ref('sagar-agent'), index);
    expect(pratik).toBe(discordDefaultAvatar(1));
    expect(sagar).toBe(discordDefaultAvatar(2));
    expect(pratik).not.toBe(sagar);
    expect(avatarFor(ref('aheen-agent'), index)).toBe('https://github.com/aheen.png');
    expect(
      avatarFor({ id: 'pratik', kind: 'human', displayName: 'Pratik' }, index),
    ).toBeUndefined();
  });

  it('rejects avatar URLs Discord cannot load', () => {
    const bad = () =>
      configFromObject({
        version: 1,
        mesh: { name: 'x' },
        humans: [{ id: 'a', displayName: 'A' }],
        agents: [{ id: 'a-agent', owner: 'a', avatarUrl: 'http://insecure.example/a.png' }],
      });
    expect(bad).toThrow(/an https:\/\/ image URL/);
  });
});
