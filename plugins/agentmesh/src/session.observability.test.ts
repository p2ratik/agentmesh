import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSession, startSession } from './session';
import { config, fakeHub, fakeServer, logger } from './session.fixture';

vi.mock('@agentmesh/bus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentmesh/bus')>()),
  connectBus: vi.fn(),
}));

const BEAT = config.heartbeatSeconds * 1000;
const OFF = { code: 'forbidden', message: 'observability is turned off on this hub' };

describe('observability turned off and on again', () => {
  let data: string;
  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), 'am-session-obs-'));
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data);
    vi.stubEnv('AGENTMESH_MESH_WINDOW', '');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(data, { recursive: true, force: true });
  });

  /**
   * A started session whose hub refuses telemetry.report with `error` and whose hello says
   * `enabled`, after its first beat (a report of connected, or an empty check); its reports' events.
   */
  async function started(error: { code: string; message: string }, enabled = true) {
    const hub = fakeHub(['s-aaaaaaaaaaaa', 's-bbbbbbbbbbbb']);
    hub.hello.observability = { enabled, maxBufferedEvents: 500 };
    hub.errors['telemetry.report'] = error;
    const reports = () =>
      hub.sent
        .filter(([subject]) => subject.endsWith('telemetry.report'))
        .map(([, params]) => (params as { events: Array<{ kind: string }> }).events);
    const session = await openSession(config, logger);
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const stop = startSession(fakeServer().server, session, logger, 0); // records connected
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(reports()).toMatchObject(enabled ? [[{ kind: 'connected' }]] : [[]]);
    return { ...hub, session, stop, reports };
  }

  // Started while the hub was off: a hub restart turns it on, and gives this session no hello.
  it('a session whose hello said off checks back each beat, and records once the hub takes one', async () => {
    const { session, stop, reports, errors, hellos } = await started(OFF, false);
    session.hub.onStatus?.('disconnect'); // off: not recorded
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(reports()).toEqual([[], []]);

    delete errors['telemetry.report'];
    await vi.advanceTimersByTimeAsync(BEAT); // the check is taken
    session.hub.onStatus?.('reconnect');
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(reports().slice(2)).toMatchObject([[], [{ kind: 'nats', event: 'reconnect' }]]);
    expect(hellos).toHaveLength(1);
    await stop();
  });

  // The hub restarts to change its config, and sessions outlive that: no hello need follow.
  it('while off, each beat checks back with an empty report; once the hub takes one, events ship', async () => {
    const { session, stop, reports, errors, hellos } = await started(OFF);
    session.hub.onStatus?.('disconnect'); // recorded while off: dropped
    await vi.advanceTimersByTimeAsync(2 * BEAT);
    expect(reports().slice(1)).toEqual([[], []]);

    delete errors['telemetry.report']; // the team turned it back on
    await vi.advanceTimersByTimeAsync(BEAT); // the check is taken: recording resumes
    session.hub.onStatus?.('reconnect');
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(reports().slice(3)).toMatchObject([[], [{ kind: 'nats', event: 'reconnect' }]]);
    expect(hellos).toHaveLength(1);
    await stop();
  });

  it('a hello that says observability is on ends the pause too', async () => {
    const { session, stop, reports, errors } = await started(OFF);
    delete errors['telemetry.report'];
    await session.sayHello();
    session.hub.onStatus?.('reconnect');
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(reports().slice(1)).toMatchObject([
      [
        { kind: 'connected', session: 's-bbbbbbbbbbbb' },
        { kind: 'nats', event: 'reconnect' },
      ],
    ]);
    await stop();
  });

  it('a hub without telemetry.report gets nothing more, not even a check', async () => {
    const gone = { code: 'not_found', message: 'Unknown method "telemetry.report"' };
    const { session, stop, reports, errors } = await started(gone);
    delete errors['telemetry.report'];
    session.hub.onStatus?.('reconnect');
    await vi.advanceTimersByTimeAsync(3 * BEAT);
    expect(reports()).toHaveLength(1);
    await stop();
  });
});
