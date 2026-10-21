import type { RpcMethodName, RpcParams, RpcResult } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';
import type { RpcHandler } from '../../contracts';
import { buildModules } from '../../runtime/modules';
import { FakeTransport } from '../../testing/fakes';
import { createTestHarness } from '../../testing/harness';

function setup() {
  const h = createTestHarness();
  const transport = new FakeTransport();
  const built = buildModules(h.ctx, null, { kick: null, sessionTransport: transport });
  const { sessions } = built.services;
  const session = sessions.open('alice-agent', { clientVersion: '0.2.0' }).session.id;
  const actor = { id: 'alice-agent', kind: 'agent' as const, roles: [] };
  const rpc = async <M extends RpcMethodName>(method: M, params: RpcParams<M>) => {
    const handler = built.handlers[method] as RpcHandler<M>;
    return (await handler(params, {
      actor,
      caller: actor,
      method,
      session,
      notes: [],
    })) as RpcResult<M>;
  };
  const codes = () => transport.checks.map((c) => c.code);
  return { ...h, transport, sessions, session, rpc, codes };
}

describe('activation check', () => {
  it('sends the session a code over its subject; only the latest fresh code activates', async () => {
    const { transport, sessions, session, rpc, codes, clock } = setup();
    expect(await rpc('session.check', {})).toEqual({ ok: true });
    expect(transport.checks).toEqual([
      { agentId: 'alice-agent', sessionId: session, code: expect.stringMatching(/^[A-Z2-9]{6}$/) },
    ]);
    const refused = { code: 'invalid_request', message: expect.stringContaining('wrong or stale') };
    const activate = (code: string) =>
      rpc('session.activate', { code, description: 'billing api' });
    await expect(activate('WRONG1')).rejects.toMatchObject(refused);
    await rpc('session.check', {});
    const [replaced, latest] = codes();
    if (replaced !== latest) await expect(activate(replaced ?? '')).rejects.toMatchObject(refused);
    clock.advance(10 * 60_000 + 1);
    await expect(activate(latest ?? '')).rejects.toMatchObject(refused);
    expect(sessions.verify('alice-agent', session).active).toBe(false);

    await rpc('session.check', {});
    const view = await activate(` ${codes().at(-1)?.toLowerCase()} `);
    expect(view).toMatchObject({ id: session, active: true, description: 'billing api' });
  });

  it('a session nobody answers for fails the check and names the likely causes', async () => {
    const { transport, rpc } = setup();
    transport.checkError = new Error('503');
    await expect(rpc('session.check', {})).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/nats\.conf[\s\S]*--dangerously-load-development-channels/),
    });
  });
});
