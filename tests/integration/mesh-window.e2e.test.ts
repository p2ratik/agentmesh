import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@agentmesh/common';
import { VERSION } from '@agentmesh/common/version';
import { MESH_WINDOW_ENV } from '@agentmesh/common/window';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../../apps/hub/src/app';
import { testTeamConfig } from '../../apps/hub/src/testing/fixtures';
import { writeGuardStamp } from '../../plugins/agentmesh/src/window/guard-stamp';
import {
  type Agent,
  activate,
  PLUGIN,
  spawnAgent,
  untilConnected,
  WINDOW_TOKEN,
  windowHome,
} from './support';

/**
 * The mesh window for real (ADR 0009): NATS (no auth), the hub and the bundled plugin over MCP
 * stdio. A window is a plugin process with the marker in its environment and the matching policy
 * in its home; the guard's stamp is written here, as dist/guard.js would on the activate call.
 * Needs AGENTMESH_TEST_NATS=nats://… with JetStream, and a built plugin.
 */
const NATS = process.env.AGENTMESH_TEST_NATS ?? '';
const PREFIX = `win${Date.now().toString(36)}`;
const QUIET_MS = 3000;

const threadOf = (sent: string) => /thr-\d+/.exec(sent)?.[0] ?? '';
const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS));

describe.skipIf(!NATS || !existsSync(PLUGIN))('the mesh window end to end', () => {
  let hub: Hub;
  let agents: Agent[] = [];

  /** A plugin process with a hub session (inactive until `activate`). */
  const spawn = async (agentId: string, extra: { home?: string; data?: string } = {}) => {
    const agent = await spawnAgent({
      agentId,
      natsUrl: NATS,
      prefix: PREFIX,
      ...(extra.home ? { home: extra.home } : {}),
      ...(extra.data
        ? { extraEnv: { [MESH_WINDOW_ENV]: WINDOW_TOKEN, CLAUDE_PLUGIN_DATA: extra.data } }
        : {}),
    });
    agents.push(agent);
    await untilConnected(() => agent.call('describe_session', { description: 'idle window' }));
    return agent;
  };

  beforeAll(async () => {
    hub = await createHub({
      loaded: testTeamConfig({
        mesh: { name: 'window-e2e', prefix: PREFIX },
        hub: { http: { enabled: false }, tickSeconds: 1 },
      }),
      dataDir: ':memory:',
      nats: { servers: [NATS] },
      logger: createLogger('window-hub', { level: 'warn', destination: 'stderr' }),
    });
    await hub.start();
  }, 30_000);

  afterEach(async () => {
    await Promise.all(agents.map((a) => a.client.close().catch(() => undefined)));
    agents = [];
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it('team work goes to the mesh window, not the session activated first', async () => {
    const [alice, b1] = await Promise.all([spawn('alice-agent'), spawn('bob-agent')]);
    await activate(b1, 'web client');
    const data = mkdtempSync(join(tmpdir(), 'am-e2e-window-data-'));
    const b2 = await spawn('bob-agent', { home: windowHome(), data });
    writeGuardStamp(data, new Date(), VERSION);
    expect(await activate(b2, 'mesh window')).toContain('It is your mesh window.');

    // b1's own activation check came before; nothing may follow it.
    const b1Before = b1.events.length;
    const threadId = threadOf(
      await alice.call('ask', { to: 'bob-agent', text: 'Does the client handle 409?' }),
    );
    const asked = await b2.waitFor((e) => e.meta.thread_id === threadId);
    expect(asked.content).toBe('│ Does the client handle 409?');
    await quiet();
    expect(b1.events.slice(b1Before)).toEqual([]);
    expect(await alice.call('peers', {})).toContain('[mesh window]');
  }, 60_000);

  it('a marked session without its guard refuses to activate', async () => {
    const data = mkdtempSync(join(tmpdir(), 'am-e2e-window-data-'));
    const b = await spawn('bob-agent', { home: windowHome(), data });
    await expect(b.call('activate', {})).rejects.toThrow('worktree guard did not run');
  }, 60_000);
});
