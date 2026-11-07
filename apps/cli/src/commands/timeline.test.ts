import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectOnce } from '@agentmesh/bus';
import { MeshError } from '@agentmesh/common';
import { describe, expect, it, vi } from 'vitest';
import type { CliContext } from '../context';
import { runCli } from '../main';
import { callTimeline } from './timeline';

vi.mock('@agentmesh/bus', async (original) => ({
  ...(await original<typeof import('@agentmesh/bus')>()),
  connectOnce: vi.fn(),
}));

function setup(opts: { agentJson?: boolean; call?: CliContext['observeCall'] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agentmesh-timeline-'));
  if (opts.agentJson !== false) {
    mkdirSync(join(home, '.agentmesh'));
    writeFileSync(
      join(home, '.agentmesh', 'agent.json'),
      JSON.stringify({
        agentId: 'pratik-agent',
        natsUrl: 'nats://x:4222',
        nkeySeed: '/seed.nk',
        prefix: 'mesh',
      }),
    );
  }
  const out: string[] = [];
  const err: string[] = [];
  const calls: unknown[] = [];
  const ctx: CliContext = {
    cwd: home,
    env: {},
    homeDir: home,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    observeCall: async (settings, params) => {
      calls.push({ settings, params });
      if (!opts.call)
        return {
          events: [
            { kind: 'tool', n: 1 },
            { kind: 'tool', n: 2 },
          ] as never,
          text: 'HEADER',
          truncated: false,
        };
      return opts.call(settings, params);
    },
  };
  return { out, err, calls, run: (...argv: string[]) => runCli(['timeline', ...argv], ctx) };
}

describe('agentmesh timeline', () => {
  it('prints text, passing the flags and the saved settings', async () => {
    const t = setup();
    expect(
      await t.run('--agent', 'bob-agent', '--thread', 'thr-3', '--since', '2h', '--limit', '10'),
    ).toBe(0);
    expect(t.out).toEqual(['HEADER']);
    expect(t.calls[0]).toEqual({
      settings: {
        agentId: 'pratik-agent',
        natsUrl: 'nats://x:4222',
        nkeySeed: '/seed.nk',
        prefix: 'mesh',
      },
      params: { agent: 'bob-agent', thread: 'thr-3', since: '2h', limit: 10 },
    });
  });

  it('--json prints one event per line', async () => {
    const t = setup();
    expect(await t.run('--json')).toBe(0);
    expect(t.out).toEqual(['{"kind":"tool","n":1}', '{"kind":"tool","n":2}']);
  });

  it('prints the hub message and exits 1 on forbidden', async () => {
    const t = setup({
      call: async () => {
        throw new MeshError('forbidden', "the timeline is for this mesh's operators only");
      },
    });
    expect(await t.run()).toBe(1);
    expect(t.err.join('')).toContain('operators only');
  });

  // The hub answers only into the caller's own inbox; any other reply subject gets no answer.
  it('connects as the agent with replies to its own inbox, and closes on an error', async () => {
    const close = vi.fn(async () => undefined);
    const request = vi.fn(async (_subject: string) => {
      throw new Error('no hub');
    });
    vi.mocked(connectOnce).mockResolvedValue({ close, request } as never);
    const settings = {
      agentId: 'pratik-agent',
      natsUrl: 'nats://x:4222',
      nkeySeed: '/seed.nk',
      prefix: 'mesh',
    };
    await expect(callTimeline(settings, {})).rejects.toThrow();
    expect(connectOnce).toHaveBeenCalledWith({
      servers: ['nats://x:4222'],
      name: 'timeline-pratik-agent',
      inboxPrefix: '_INBOX_pratik-agent',
      credentials: { nkeySeed: '/seed.nk' },
    });
    expect(request.mock.calls[0]?.[0]).toBe('mesh.rpc.pratik-agent.observe.timeline');
    expect(close).toHaveBeenCalledOnce();
  });

  it('asks to join first when agent.json is missing', async () => {
    const t = setup({ agentJson: false });
    expect(await t.run()).toBe(1);
    expect(t.err.join('')).toContain('agentmesh agent-setup --write');
    expect(t.calls).toEqual([]);
  });
});
