import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@agentmesh/common';
import { MeshError } from '@agentmesh/common';
import { VERSION } from '@agentmesh/common/version';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelEvent } from '../inbox/render';
import { writeGuardStamp } from '../window/guard-stamp';
import { answerCheck, checkEvent } from './activation';
import { fakeHub } from './fake-hub';
import { callTool } from './registry';

const SYSTEM = { kind: 'system', from: 'agentmesh' };
const ACTIVE_AGAIN =
  'AgentMesh: this session reconnected after a long absence and is active again as "checkout redesign". Call inbox to catch up.';
const RENEWED_CHECK =
  'This session reconnected to the mesh after a long absence. Your human activated it earlier; finishing this check continues that activation. AgentMesh activation check. Code: K7Q2ZP. To finish, call activate(code: "K7Q2ZP", description: "checkout redesign"). Write a new line instead if the focus changed.';

describe('checkEvent', () => {
  it('asks for a line on a first activation', () => {
    expect(checkEvent('K7Q2ZP')).toEqual({
      content:
        'AgentMesh activation check. Code: K7Q2ZP. To finish, call activate(code: "K7Q2ZP", description: "<one line: what this session is working on>").',
      meta: SYSTEM,
    });
  });

  it('after a renewal, says it continues the activation the human started', () => {
    expect(checkEvent('K7Q2ZP', 'checkout redesign')).toEqual({
      content: RENEWED_CHECK,
      meta: SYSTEM,
    });
  });
});

describe('answerCheck', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'am-activation-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  /** A session that the hub renewed after a push activation in this process (`recheck` ran). */
  function setup(answers: Record<string, unknown>, renewed = true) {
    const { deps, calls } = fakeHub(answers);
    if (renewed) {
      deps.activation.lastDescription = 'checkout redesign';
      deps.activation.renewedFrom = 'checkout redesign';
    }
    const pushed: ChannelEvent[] = [];
    const logger = { info: vi.fn(), warn: vi.fn() };
    const refresh = vi.fn(async () => undefined);
    const answer = {
      hub: Object.assign(deps.hub, { sessionId: 's-bbbbbbbbbbbb' }),
      activation: deps.activation,
      window: deps.window,
      logger: logger as unknown as Logger,
      push: async (event: ChannelEvent) => void pushed.push(event),
      refresh,
    };
    return { deps, answer, calls, pushed, logger, refresh };
  }

  const view = { id: 's-bbbbbbbbbbbb', active: true, description: 'checkout redesign' };

  // The human's activate is theirs: their typed line, and the window's rules with the result.
  it('a manual activate during a renewal sends Claude the check, unanswered', async () => {
    const { deps, answer, calls, pushed } = setup({ 'session.check': { ok: true } });
    await callTool('activate', {}, deps);
    await answerCheck('K7Q2ZP', answer);
    expect(calls.map((c) => c.method)).toEqual(['session.check']);
    expect(pushed).toEqual([checkEvent('K7Q2ZP')]);
    expect(deps.activation).toMatchObject({ lastDescription: null, renewedFrom: null });
  });

  it('a first activation pushes the check to Claude, untouched', async () => {
    const { answer, calls, pushed } = setup({}, false);
    await answerCheck('K7Q2ZP', answer);
    expect(calls).toEqual([]);
    expect(pushed).toEqual([checkEvent('K7Q2ZP')]);
  });

  it('a renewal after a push activation in this process answers the code itself', async () => {
    const { deps, answer, calls, pushed, logger, refresh } = setup({ 'session.activate': view });
    await answerCheck('K7Q2ZP', answer);
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ['session.activate', { code: 'K7Q2ZP', description: 'checkout redesign' }],
    ]);
    expect(pushed).toEqual([{ content: ACTIVE_AGAIN, meta: SYSTEM }]);
    expect(deps.activation).toEqual({
      lastDescription: 'checkout redesign',
      renewedFrom: null,
      pull: false,
      guardVersion: null,
      epoch: 0,
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      { session: 's-bbbbbbbbbbbb' },
      'new hub session; re-activated it in the same process',
    );
  });

  it('a renewal the hub refuses falls back to the check, saying it continues the activation', async () => {
    const refused = new MeshError('invalid_request', 'That code is wrong or stale.');
    const { deps, answer, pushed, logger, refresh } = setup({ 'session.activate': refused });
    await answerCheck('K7Q2ZP', answer);
    expect(pushed).toEqual([{ content: RENEWED_CHECK, meta: SYSTEM }]);
    expect(deps.activation.renewedFrom).toBe('checkout redesign');
    expect(refresh).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  // The guard stamps only an activate call, so after a long sleep the stamp is stale: the version
  // the window's last activate recorded in this process is its proof that the guard runs.
  it('the mesh window re-activates on the guard version its activate recorded', async () => {
    const { deps, answer, calls, pushed } = setup({ 'session.activate': view });
    writeGuardStamp(dataDir, new Date(Date.now() - 3 * 3_600_000), VERSION);
    deps.activation.guardVersion = VERSION;
    answer.window = { ...answer.window, state: 'verified', setUp: true, dataDir };
    await answerCheck('K7Q2ZP', answer);
    expect(calls.map((c) => c.method)).toEqual(['session.activate']);
    expect(pushed).toEqual([{ content: ACTIVE_AGAIN, meta: SYSTEM }]);
    expect(deps.activation.guardVersion).toBe(VERSION);
  });

  it('a mesh window without proof that its guard runs falls back to the check', async () => {
    const { answer, calls, pushed, logger } = setup({ 'session.activate': view });
    writeGuardStamp(dataDir, new Date(Date.now() - 3 * 3_600_000), VERSION);
    for (const state of ['verified', 'marked'] as const) {
      answer.window = { ...answer.window, state, setUp: state === 'verified', dataDir };
      await answerCheck('K7Q2ZP', answer);
    }
    expect(calls).toEqual([]);
    expect(pushed).toEqual([
      { content: RENEWED_CHECK, meta: SYSTEM },
      { content: RENEWED_CHECK, meta: SYSTEM },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  // After a fallback, the human's /agentmesh:activate stamps the guard; the check it asks for is
  // answered here, and records the stamp's version as the activate tool would.
  it('a mesh window with a fresh stamp re-activates and records its version', async () => {
    const { deps, answer, calls } = setup({ 'session.activate': view });
    writeGuardStamp(dataDir, new Date(), VERSION);
    answer.window = { ...answer.window, state: 'verified', setUp: true, dataDir };
    await answerCheck('K7Q2ZP', answer);
    expect(calls.map((c) => c.method)).toEqual(['session.activate']);
    expect(deps.activation.guardVersion).toBe(VERSION);
  });
});
