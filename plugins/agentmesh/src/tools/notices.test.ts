import { describe, expect, it } from 'vitest';
import { fakeHub } from './fake-hub';
import { callTool } from './registry';

const LINE =
  'Your earlier question in thr-12 has come back to this session; read it with thread thr-12 for its answer.';

describe('session notices', () => {
  it('end the next tool result once', async () => {
    const { deps } = fakeHub({ 'peers.list': { peers: [] } });
    deps.notices.push(LINE);
    const first = await callTool('peers', {}, deps);
    expect(first.content.at(-1)?.text).toBe(LINE);
    const second = await callTool('peers', {}, deps);
    expect(second.content.map((c) => c.text)).not.toContain(LINE);
    expect(deps.notices).toEqual([]);
  });
});
