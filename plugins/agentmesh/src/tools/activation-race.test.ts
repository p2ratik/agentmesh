import type { Logger } from '@agentmesh/common';
import { describe, expect, it, vi } from 'vitest';
import type { HubClient } from '../hub';
import type { ChannelEvent } from '../inbox/render';
import { answerCheck, reactivatePull } from './activation';
import { fakeHub, text } from './fake-hub';
import { callTool } from './registry';

/**
 * A renewed session answering its check, and the activate tool, both race a deactivate. This hub
 * runs each call only when the test says so, so the test picks which one the hub runs first;
 * `state.active` is the hub session's state.
 */
function setup() {
  const state = { active: false };
  const pending: Array<{ method: string; run(fail?: Error): void }> = [];
  const call = (method: string) =>
    new Promise((resolve, reject) => {
      const run = (fail?: Error) => {
        if (fail) return reject(fail);
        if (method === 'session.activate') state.active = true;
        if (method === 'session.deactivate') state.active = false;
        const { active } = state;
        resolve({
          id: 's-bbbbbbbbbbbb',
          active,
          description: 'x',
          repo: null,
          branch: null,
          owns: [],
        });
      };
      pending.push({ method, run });
    });
  /** The hub runs (or fails) the oldest call to `method`, once the plugin has sent it. */
  const run = async (method: string, fail?: Error) => {
    await vi.waitFor(() => expect(pending.map((p) => p.method)).toContain(method));
    pending
      .splice(
        pending.findIndex((p) => p.method === method),
        1,
      )[0]
      ?.run(fail);
  };
  const { deps } = fakeHub({});
  deps.hub = {
    call,
    reportSeen: () => undefined,
    sessionId: 's-bbbbbbbbbbbb',
  } as unknown as HubClient;
  deps.activation.lastDescription = 'checkout redesign';
  deps.activation.renewedFrom = 'checkout redesign';
  const pushed: ChannelEvent[] = [];
  const logger = { info: vi.fn(), warn: vi.fn() };
  const answer = {
    hub: deps.hub as HubClient,
    activation: deps.activation,
    window: deps.window,
    logger: logger as unknown as Logger,
    push: async (event: ChannelEvent) => void pushed.push(event),
    refresh: vi.fn(async () => undefined),
    agentSessions: () => [],
    recorder: deps.recorder,
  };
  return { state, run, deps, answer, pushed, logger };
}

const OFF = { lastDescription: null, renewedFrom: null, pull: false, guardVersion: null };

describe('a deactivate wins over a renewal that re-activates itself', () => {
  it('the hub runs the deactivate first: the plugin turns the session off again', async () => {
    const { state, run, deps, answer, pushed } = setup();
    const checked = answerCheck('K7Q2ZP', answer);
    const off = callTool('deactivate', {}, deps);
    await run('session.deactivate');
    await off;
    await run('session.activate');
    expect(state.active).toBe(true);
    await run('session.deactivate');
    await checked;
    expect(state.active).toBe(false);
    expect(deps.activation).toMatchObject(OFF);
    expect(pushed).toEqual([]);
  });

  it('the hub runs the activate first: nothing is recorded or pushed', async () => {
    const { state, run, deps, answer, pushed, logger } = setup();
    const checked = answerCheck('K7Q2ZP', answer);
    const off = callTool('deactivate', {}, deps);
    // The deactivate is out (its local state already cleared) when the activate's answer lands.
    await vi.waitFor(() => expect(deps.activation.lastDescription).toBeNull());
    await run('session.activate');
    await run('session.deactivate');
    await off;
    await run('session.deactivate');
    await checked;
    expect(state.active).toBe(false);
    expect(deps.activation).toMatchObject(OFF);
    expect(pushed).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      { session: 's-bbbbbbbbbbbb' },
      'deactivated while re-activating the new hub session; it stays off',
    );
  });

  it('a re-activation that fails after a deactivate gives Claude no check to finish', async () => {
    const { run, deps, answer, pushed } = setup();
    const checked = answerCheck('K7Q2ZP', answer);
    const off = callTool('deactivate', {}, deps);
    await run('session.deactivate');
    await off;
    await run('session.activate', new Error('timed out'));
    await checked;
    expect(pushed).toEqual([]);
  });

  // A pull session gets no check: recheck re-activates it in pull mode at once (reactivatePull).
  it('a pull renewal loses to a deactivate too: the hub ends inactive', async () => {
    const { state, run, deps, answer } = setup();
    deps.activation.renewedFrom = null;
    deps.activation.pull = true;
    const renewed = reactivatePull(answer);
    const off = callTool('deactivate', {}, deps);
    await run('session.deactivate');
    await off;
    await run('session.activate');
    expect(state.active).toBe(true);
    await run('session.deactivate');
    await renewed;
    expect(state.active).toBe(false);
    expect(deps.activation).toMatchObject(OFF);
    expect(answer.refresh).not.toHaveBeenCalled();
  });

  it('a deactivate during the activate tool wins too', async () => {
    const { state, run, deps } = setup();
    deps.activation.renewedFrom = null;
    const on = callTool('activate', { code: 'K7Q2ZP', description: 'checkout redesign' }, deps);
    const off = callTool('deactivate', {}, deps);
    await run('session.deactivate');
    await off;
    await run('session.activate');
    await run('session.deactivate');
    expect(text(await on)).toBe(
      'This session was turned off while it activated, so it stays off; /agentmesh:activate turns it back on.',
    );
    expect(state.active).toBe(false);
    expect(deps.activation).toMatchObject(OFF);
  });
});
