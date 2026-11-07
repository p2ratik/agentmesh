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

  it('a forbidden report stops reporting until a hello says observability is on', async () => {
    const { hello, errors, sent } = fakeHub(['s-aaaaaaaaaaaa', 's-bbbbbbbbbbbb']);
    hello.observability = { enabled: true, maxBufferedEvents: 500 };
    errors['telemetry.report'] = {
      code: 'forbidden',
      message: 'observability is turned off on this hub',
    };
    const reports = () =>
      sent
        .filter(([subject]) => subject.endsWith('telemetry.report'))
        .map(([, params]) => (params as { events: Array<{ kind: string }> }).events);
    const session = await openSession(config, logger);
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const stop = startSession(fakeServer().server, session, logger, 0); // records connected
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(reports()).toMatchObject([[{ kind: 'connected' }]]);

    // Refused: what it held is dropped, and nothing more is recorded or sent.
    session.hub.onStatus?.('disconnect');
    await vi.advanceTimersByTimeAsync(2 * BEAT);
    expect(reports()).toHaveLength(1);

    // The team turns it back on: the next hello says so, and new events ship again.
    delete errors['telemetry.report'];
    await session.sayHello();
    session.hub.onStatus?.('reconnect');
    await vi.advanceTimersByTimeAsync(BEAT);
    expect(reports()).toHaveLength(2);
    expect(reports()[1]).toMatchObject([
      { kind: 'connected', session: 's-bbbbbbbbbbbb' },
      { kind: 'nats', event: 'reconnect' },
    ]);
    await stop();
  });
});
