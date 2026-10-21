import { MeshError } from '@agentmesh/common';
import { RPC_METHODS } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { CallContext, RpcHandlerMap, SessionRecord } from '../contracts';
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
    transaction: (fn) => h.ctx.db.transaction(fn),
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

  it('keeps keys per method: reusing one for another method neither skips nor clobbers', () => {
    const h = createServiceHarness(testTeamConfig());
    const store = new IdempotencyStore(h.ctx.db, h.clock);
    store.put('alice-agent', 'k1', 'task.get', { first: true });
    store.reserve('alice-agent', 'k1', 'task.act');
    expect(store.get('alice-agent', 'k1', 'task.act')).toEqual({ found: true, pending: true });
    store.release('alice-agent', 'k1', 'task.act');
    expect(store.get('alice-agent', 'k1', 'task.get')).toMatchObject({
      found: true,
      response: { first: true },
    });
  });

  it('frees the key when the handler fails, so the same key can retry', async () => {
    const { call, calls, failures } = setup(false);
    failures.next = 1;
    await expect(call('k1')).rejects.toThrowError('handler failed');
    expect(await call('k1')).toEqual({ secret: SECRET, call: 2 });
    expect(calls()).toBe(2);
  });
});

describe('RPC router sessions', () => {
  function sessionSetup(options: { failClaims?: boolean; asyncHandler?: boolean } = {}) {
    const h = createServiceHarness(testTeamConfig());
    h.ctx.db.exec('CREATE TABLE scratch (v TEXT)');
    const seen: string[] = [];
    const sessions = {
      verify: (agentId: string, sessionId: string) => {
        seen.push(`verify ${agentId} ${sessionId}`);
        if (sessionId !== 's-good') throw new MeshError('not_found', 'Unknown or closed session');
        return {} as SessionRecord;
      },
      recordClaims: (call: CallContext, method: string) => {
        seen.push(`claims ${method} ${call.session}`);
        if (options.failClaims) throw new Error('claim failed');
        call.notes.push('a note');
      },
    };
    const send = (_params: unknown, call: CallContext) => {
      seen.push(`handler ${call.session}`);
      h.ctx.db.run("INSERT INTO scratch (v) VALUES ('acted')");
      const result = { messageId: 'msg-1', threadId: 'thr-1', deliveredTo: [], held: false };
      return options.asyncHandler ? Promise.resolve(result) : result;
    };
    const handlers = {
      'message.send': send,
      'session.hello': () => ({ sessionId: 's-good' }),
      'session.bye': () => ({ ok: true }),
    };
    const dispatch = createRpcRouter({
      index: () => h.ctx.index,
      handlers: handlers as unknown as Partial<RpcHandlerMap>,
      idempotency: new IdempotencyStore(h.ctx.db, h.clock),
      logger: h.ctx.logger,
      sessions,
      transaction: (fn) => h.ctx.db.transaction(fn),
    });
    const params = { kind: 'ask', to: ['bob-agent'], body: 'hi' };
    const call = (caller: string, session: string, notes: string[] = []) =>
      dispatch(
        {
          caller,
          method: 'message.send',
          session,
          notes,
          ...(caller === 'discord-bridge' ? { actAs: 'bob' } : {}),
        },
        params,
      );
    const rows = () => h.ctx.db.all('SELECT v FROM scratch').length;
    return { call, seen, rows, dispatch, params };
  }

  it('refuses agent calls without a session, except hello and bye', async () => {
    const { dispatch, params } = sessionSetup();
    await expect(
      dispatch({ caller: 'alice-agent', method: 'message.send' }, params),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message:
        "This session isn't registered with the hub. If your AgentMesh plugin is older than " +
        '0.2.0, update it: claude plugin update agentmesh@agentmesh, then restart Claude Code.',
    });
    const hello = { clientVersion: '0.2.0' };
    await expect(
      dispatch({ caller: 'alice-agent', method: 'session.hello' }, hello),
    ).resolves.toEqual({ sessionId: 's-good' });
    await expect(dispatch({ caller: 'alice-agent', method: 'session.bye' }, {})).resolves.toEqual({
      ok: true,
    });
    const asBob = { caller: 'discord-bridge', method: 'message.send', actAs: 'bob' };
    await expect(dispatch(asBob, params)).resolves.toMatchObject({ threadId: 'thr-1' });
  });

  it('router verifies the session and records claims after success', async () => {
    const { call, seen } = sessionSetup();
    const notes: string[] = [];
    await call('alice-agent', 's-good', notes);
    expect(seen).toEqual([
      'verify alice-agent s-good',
      'handler s-good',
      'claims message.send s-good',
    ]);
    expect(notes).toEqual(['a note']);

    await expect(call('alice-agent', 's-bad')).rejects.toMatchObject({ code: 'not_found' });
    expect(seen).not.toContain('handler s-bad');

    seen.length = 0;
    await call('discord-bridge', 's-bad');
    expect(seen).toEqual(['handler null', 'claims message.send null']);
  });

  it('a failing claim rolls back the action', async () => {
    const { call, rows } = sessionSetup({ failClaims: true });
    await expect(call('alice-agent', 's-good')).rejects.toThrowError('claim failed');
    expect(rows()).toBe(0);
  });

  it('refuses an async claiming handler as internal and keeps nothing', async () => {
    const { call, rows, seen } = sessionSetup({ asyncHandler: true });
    await expect(call('alice-agent', 's-good')).rejects.toMatchObject({ code: 'internal' });
    expect(rows()).toBe(0);
    expect(seen).not.toContain('claims message.send s-good');
  });
});
