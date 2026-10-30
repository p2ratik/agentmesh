import { describe, expect, it } from 'vitest';
import type { RpcHandlerMap } from '../contracts';
import { testTeamConfig } from '../testing/fixtures';
import { createServiceHarness } from '../testing/services';
import { IdempotencyStore } from './idempotency';
import { createRpcRouter } from './router';

function setup() {
  const h = createServiceHarness(testTeamConfig({ limits: { rpcBurst: 3, rpcPerMinute: 6 } }));
  let now = 0;
  const handlers = {
    'thread.close': async () => ({}),
    'peers.list': async () => ({ peers: [] }),
    'inbox.peek': async () => ({ threads: 0, actions: 0, from: [], external: false }),
    'refs.set': async () => ({ ok: true }),
  } as unknown as Partial<RpcHandlerMap>;
  const dispatch = createRpcRouter({
    index: () => h.ctx.index,
    handlers,
    idempotency: new IdempotencyStore(h.ctx.db, h.clock),
    logger: h.ctx.logger,
    transaction: (fn) => h.ctx.db.transaction(fn),
    now: () => now,
  });
  const close = (caller = 'alice-agent', actAs?: string) =>
    dispatch(
      { caller, method: 'thread.close', ...(actAs ? { actAs } : {}) },
      { threadId: 'thr-1' },
    );
  const peers = () => dispatch({ caller: 'alice-agent', method: 'peers.list' }, {});
  const peek = () => dispatch({ caller: 'alice-agent', method: 'inbox.peek' }, {});
  const refs = () =>
    dispatch(
      { caller: 'discord-bridge', method: 'refs.set' },
      { system: 'discord', entityType: 'thread', entityId: 'thr-1', ref: '42' },
    );
  const advance = (ms: number) => {
    now += ms;
  };
  return { close, peers, peek, refs, advance };
}

describe('RPC rate limit', () => {
  it('refuses calls past the burst until the bucket refills', async () => {
    const { close, advance } = setup();
    for (let i = 0; i < 3; i += 1) await close();
    await expect(close()).rejects.toMatchObject({
      code: 'rate_limited',
      details: { retryAfterSeconds: 10 },
    });
    advance(10_000);
    await close();
    await expect(close()).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('never meters reads, pull sessions polling their inbox included', async () => {
    const { close, peers, peek } = setup();
    for (let i = 0; i < 3; i += 1) await close();
    for (let i = 0; i < 10; i += 1) await peers();
    for (let i = 0; i < 10; i += 1) await peek();
  });

  it('meters each participant on its own, humans the bridge acts for included', async () => {
    const { close } = setup();
    for (let i = 0; i < 3; i += 1) await close('discord-bridge', 'alice');
    await expect(close('discord-bridge', 'alice')).rejects.toMatchObject({ code: 'rate_limited' });
    await close('discord-bridge', 'bob');
    await close('bob-agent');
  });

  it('does not meter a service acting as itself', async () => {
    const { refs } = setup();
    for (let i = 0; i < 10; i += 1) await refs();
  });
});
