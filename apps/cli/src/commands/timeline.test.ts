import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectOnce } from '@agentmesh/bus';
import { MeshError } from '@agentmesh/common';
import { describe, expect, it, vi } from 'vitest';
import type { CliContext } from '../context';
import { runCli } from '../main';
import { callTimeline } from './timeline';

const SETTINGS = {
  agentId: 'pratik-agent',
  natsUrl: 'nats://x:4222',
  nkeySeed: '/seed.nk',
  prefix: 'mesh',
};

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
    await expect(callTimeline(SETTINGS, {})).rejects.toThrow();
    expect(connectOnce).toHaveBeenCalledWith({
      servers: ['nats://x:4222'],
      name: 'timeline-pratik-agent',
      inboxPrefix: '_INBOX_pratik-agent',
      credentials: { nkeySeed: '/seed.nk' },
    });
    expect(request.mock.calls[0]?.[0]).toBe('mesh.rpc.pratik-agent.observe.timeline');
    expect(close).toHaveBeenCalledOnce();
  });

  // The exit grace would hide a connection left open on success: the close must still happen.
  it('returns the hub result and closes the connection after it', async () => {
    const result = { events: [], text: 'no events in this window', truncated: false };
    const close = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ json: () => ({ ok: true, result }) }));
    vi.mocked(connectOnce).mockResolvedValue({ close, request } as never);
    expect(await callTimeline(SETTINGS, {})).toEqual(result);
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.invocationCallOrder[0]).toBeGreaterThan(
      request.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('asks to join first when agent.json is missing', async () => {
    const t = setup({ agentJson: false });
    expect(await t.run()).toBe(1);
    expect(t.err.join('')).toContain('agentmesh agent-setup --write');
    expect(t.calls).toEqual([]);
  });

  it.each(['0', '-3', '1.5', 'ten', '2e3'])(
    'refuses --limit %s as a usage error',
    async (limit) => {
      const t = setup();
      expect(await t.run(`--limit=${limit}`)).toBe(2);
      expect(t.err.join('')).toContain('--limit must be a positive whole number');
      expect(t.calls).toEqual([]);
    },
  );

  it('--json says on stderr when the hub cut the timeline short', async () => {
    const t = setup({ call: async () => ({ events: [], text: '', truncated: true }) });
    expect(await t.run('--json')).toBe(0);
    expect(t.out).toEqual([]);
    expect(t.err.join('')).toContain('truncated: only the newest events are shown');
  });

  it('the help says AGENTMESH_* overrides are ignored', async () => {
    const t = setup();
    expect(await t.run('--help')).toBe(0);
    expect(t.out.join('')).toContain('AGENTMESH_* environment overrides are ignored');
  });

  // On Windows a refused key can show as a reset; neither shows the server's own text.
  it.each([
    ['Authorization Violation', "The hub refused pratik-agent's key"],
    ['read ECONNRESET', "it may have refused pratik-agent's key"],
    ['connect ECONNREFUSED 10.0.0.1:4222', 'Could not reach the hub at nats://x:4222'],
  ])('maps a failed connect (%s) to a clear message', async (raw, words) => {
    vi.mocked(connectOnce).mockRejectedValue(new Error(raw));
    const error = await callTimeline(SETTINGS, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeshError);
    expect((error as Error).message).toContain(words);
    expect((error as Error).message).not.toContain(raw);
  });
});
