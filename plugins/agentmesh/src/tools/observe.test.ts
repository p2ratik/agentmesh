import { MeshError } from '@agentmesh/common';
import { describe, expect, it } from 'vitest';
import { fakeHub, text } from './fake-hub';
import { callTool } from './registry';

describe('timeline tool', () => {
  it("prints the hub's text, and a forbidden refusal as an error", async () => {
    const { deps, calls } = fakeHub({
      'observe.timeline': { events: [], text: 'Timeline\n(truncated: narrow)', truncated: true },
    });
    const ok = await callTool(
      'timeline',
      { agent: 'bob-agent', thread_id: 'thr-4', since: '2h' },
      deps,
    );
    expect(text(ok)).toBe('Timeline\n(truncated: narrow)');
    expect(calls[0]?.method).toBe('observe.timeline');
    expect(calls[0]?.params).toEqual({ agent: 'bob-agent', thread: 'thr-4', since: '2h' });

    const denied = fakeHub({
      'observe.timeline': new MeshError(
        'forbidden',
        "the timeline is for this mesh's operators only",
      ),
    });
    const refused = await callTool('timeline', {}, denied.deps);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('forbidden');
    expect(text(refused)).toContain('operators only');
  });
});
