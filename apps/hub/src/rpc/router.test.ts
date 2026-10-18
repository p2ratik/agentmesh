import { RPC_METHODS } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { RpcHandlerMap } from '../contracts';
import { testTeamConfig } from '../testing/fixtures';
import { createServiceHarness } from '../testing/services';
import { IdempotencyStore } from './idempotency';
import { createRpcRouter } from './router';

const SECRET = 'invite-plaintext-s3cret';

function setup(cacheResponse?: boolean) {
  const h = createServiceHarness(testTeamConfig());
  let calls = 0;
  const failures = { next: 0 };
  const handlers = {
    'mesh.status': async () => {
      calls += 1;
      if (failures.next > 0) {
        failures.next -= 1;
        throw new Error('handler failed');
      }
      return { secret: SECRET, call: calls };
    },
  } as unknown as Partial<RpcHandlerMap>;
  const methods = {
    ...RPC_METHODS,
    'mesh.status': { ...RPC_METHODS['mesh.status'], cacheResponse },
  };
  const dispatch = createRpcRouter({
    index: () => h.ctx.index,
    handlers,
    idempotency: new IdempotencyStore(h.ctx.db, h.clock),
    logger: h.ctx.logger,
    methods,
  });
  const call = (idempotencyKey?: string) =>
    dispatch(
      {
        caller: 'alice-agent',
        method: 'mesh.status',
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
      {},
    );
  const stored = () =>
    h.ctx.db
      .all<{ response: string }>('SELECT response FROM rpc_idempotency')
      .map((r) => r.response);
  return { call, stored, calls: () => calls, failures };
}

describe('RPC router idempotency', () => {
  it('replays the cached response for a repeated key by default', async () => {
    const { call, calls } = setup();
    const first = await call('k1');
    expect(await call('k1')).toEqual(first);
    expect(calls()).toBe(1);
  });

  it('never stores the response of a cacheResponse:false method', async () => {
    const { call, stored } = setup(false);
    expect(await call('k1')).toEqual({ secret: SECRET, call: 1 });
    expect(stored().join('\n')).not.toContain(SECRET);
  });

  it('refuses a repeated key for a cacheResponse:false method instead of running it twice', async () => {
    const { call, stored, calls } = setup(false);
    await call('k1');
    await expect(call('k1')).rejects.toMatchObject({ code: 'conflict' });
    expect(calls()).toBe(1);
    expect(stored().join('\n')).not.toContain(SECRET);
  });

  it('runs a cacheResponse:false method normally for a new key', async () => {
    const { call, calls } = setup(false);
    await call('k1');
    expect(await call('k2')).toEqual({ secret: SECRET, call: 2 });
    expect(calls()).toBe(2);
  });

  it.each([true, false])(
    'runs the handler once when two calls with one key overlap (cacheResponse %s)',
    async (cacheResponse) => {
      const { call, calls } = setup(cacheResponse);
      const [first, second] = await Promise.allSettled([call('k1'), call('k1')]);
      expect(first.status).toBe('fulfilled');
      expect(second).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } });
      expect(calls()).toBe(1);
    },
  );

  it('frees the key when the handler fails, so the same key can retry', async () => {
    const { call, calls, failures } = setup(false);
    failures.next = 1;
    await expect(call('k1')).rejects.toThrowError('handler failed');
    expect(await call('k1')).toEqual({ secret: SECRET, call: 2 });
    expect(calls()).toBe(2);
  });
});
