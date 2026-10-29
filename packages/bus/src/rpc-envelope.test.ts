import { createLogger } from '@agentmesh/common';
import { describe, expect, it } from 'vitest';
import { type RpcDispatcher, serveRpc } from './rpc-server';

/**
 * Runs one request through serveRpc with a fake connection; resolves to the parsed response,
 * or to `null` if nothing was sent within 50 ms.
 */
async function roundTrip(
  dispatch: RpcDispatcher,
  envelope: unknown,
  reply = '_INBOX_alice-agent.r1',
): Promise<unknown> {
  let callback: (err: Error | null, msg: unknown) => void = () => {};
  const nc = {
    subscribe: (_subject: string, opts: { callback: typeof callback }) => {
      callback = opts.callback;
      return {};
    },
  };
  serveRpc(nc as never, dispatch, {
    prefix: 'mesh',
    logger: createLogger('test', { level: 'silent' }),
  });
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), 50);
    callback(null, {
      subject: 'mesh.rpc.alice-agent.ping',
      reply,
      json: () => envelope,
      respond: (data: string) => resolve(JSON.parse(data)),
    });
  });
}

const env = (extra: object = {}) => ({ v: 1, params: {}, ...extra });

describe('rpc envelope', () => {
  it('passes the envelope session to the dispatcher', async () => {
    let seen: string | undefined;
    await roundTrip(
      async (ctx) => {
        seen = ctx.session;
        return 1;
      },
      env({ session: 's-abc123def456' }),
    );
    expect(seen).toBe('s-abc123def456');
  });

  it('returns notes the dispatcher added', async () => {
    const res = await roundTrip(async (ctx) => {
      ctx.notes?.push('n1');
      return 1;
    }, env());
    expect(res).toEqual({ ok: true, result: 1, notes: ['n1'] });
  });

  it('omits empty notes', async () => {
    const res = await roundTrip(async () => 1, env());
    expect(res).toEqual({ ok: true, result: 1 });
    expect(res).not.toHaveProperty('notes');
  });
});

describe('rpc reply subject', () => {
  it("answers only into the caller's own inbox", async () => {
    let ran = 0;
    const dispatch: RpcDispatcher = async () => {
      ran += 1;
      return 1;
    };
    for (const reply of [
      'mesh.presence.bob-agent',
      'mesh.evt.task.created',
      '$JS.API.STREAM.PURGE.MESH_EVENTS',
      '_INBOX_bob-agent.r1',
      '_INBOX_alice-agent-x.r1',
      '_INBOX_alice-agent',
    ]) {
      expect(await roundTrip(dispatch, env(), reply)).toBeNull();
    }
    expect(ran).toBe(0);
    expect(await roundTrip(dispatch, env())).toEqual({ ok: true, result: 1 });
  });
});
