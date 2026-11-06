import { describe, expect, it } from 'vitest';
import { fakeHub } from './fake-hub';
import { callTool } from './registry';

const LINE =
  'thr-12 is back with this session, which held it before the hub closed it; read it with thread thr-12 to catch up.';

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
