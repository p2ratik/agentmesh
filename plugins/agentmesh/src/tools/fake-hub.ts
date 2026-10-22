import type { HubClient } from '../hub';
import { FyiBuffer } from '../inbox/fyi';
import { newActivationState } from './activation';
import type { ToolDeps } from './types';

/**
 * Tool deps for tests: a HubClient stand-in that records calls and answers
 * from a table and, like the real client, puts the hub's `notes` for a method
 * into the caller's sink. `reportSeen` is recorded as the `messages.seen` it sends.
 */
export function fakeHub(answers: Record<string, unknown>, notes: Record<string, string[]> = {}) {
  const calls: Array<{ method: string; params: unknown; options: unknown }> = [];
  const hub = {
    call: async (method: string, params: unknown, options: unknown, sink?: string[]) => {
      calls.push({ method, params, options });
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      sink?.push(...(notes[method] ?? []));
      return answer;
    },
    reportSeen: (messageIds: string[]) =>
      calls.push({ method: 'messages.seen', params: { messageIds }, options: undefined }),
  } as unknown as HubClient;
  const deps: ToolDeps = {
    hub,
    agentId: 'alice-agent',
    activation: newActivationState(),
    fyi: new FyiBuffer(),
  };
  return { deps, calls };
}

export const text = (result: { content: Array<{ text: string }> }, index = 0): string =>
  result.content[index]?.text ?? '';
