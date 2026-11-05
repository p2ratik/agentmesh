import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@agentmesh/common';
import { VERSION } from '@agentmesh/common/version';
import { MESH_WINDOW_ENV } from '@agentmesh/common/window';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../../apps/hub/src/app';
import { internalId } from '../../apps/hub/src/core/ids';
import { testTeamConfig } from '../../apps/hub/src/testing/fixtures';
import { forwardFile } from '../../plugins/agentmesh/src/relay/forward-record';
import { readLocalSessions } from '../../plugins/agentmesh/src/relay/local-session';
import { pointerText } from '../../plugins/agentmesh/src/relay/pointer';
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
 * Plan 3 for real: NATS (no auth), the hub and the bundled plugin over MCP stdio. Bob's private
 * session and his mesh window share one home and one plugin data folder, as on one laptop; their
 * messaging addresses are fake, since nothing here sends to them. The relay runs on Windows only,
 * so elsewhere the window must stay quiet. Needs AGENTMESH_TEST_NATS=nats://… with JetStream, and
 * a built plugin.
 */
const NATS = process.env.AGENTMESH_TEST_NATS ?? '';
const PREFIX = `rel${Date.now().toString(36)}`;
const QUIET_MS = 3000;
const PRIVATE_HEX = '1'.repeat(32);
const PRIVATE = `\\\\.\\pipe\\LOCAL\\cc-msg-${PRIVATE_HEX}`;
const WINDOW = `\\\\.\\pipe\\LOCAL\\cc-msg-${'2'.repeat(32)}`;

const threadOf = (sent: string) => /thr-\d+/.exec(sent)?.[0] ?? '';
const messageOf = (sent: string) => /msg-[0-9A-Z]{26}/.exec(sent)?.[0] ?? '';
const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS));

/** Polls until `fn` returns something, for state a plugin or the hub writes after an ack. */
async function until<T>(fn: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!NATS || !existsSync(PLUGIN))('the relay end to end', () => {
  let hub: Hub;
  let agents: Agent[] = [];
  let temps: string[] = [];

  const temp = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), name));
    temps.push(dir);
    return dir;
  };

  const spawn = async (agentId: string, home: string, extraEnv: Record<string, string> = {}) => {
    const agent = await spawnAgent({ agentId, natsUrl: NATS, prefix: PREFIX, home, extraEnv });
    agents.push(agent);
    // A mesh call: from now on a private session keeps its local record.
    await untilConnected(() => agent.call('describe_session', { description: 'e2e' }));
    return agent;
  };

  const spawnAlice = () => spawn('alice-agent', temp('am-e2e-home-'));

  /** Bob's laptop: one home and one plugin data folder. */
  const laptop = () => {
    const home = windowHome();
    temps.push(home);
    return { home, data: temp('am-e2e-relay-data-') };
  };

  const spawnPrivate = ({ home, data }: { home: string; data: string }) =>
    spawn('bob-agent', home, { CLAUDE_PLUGIN_DATA: data, CLAUDE_CODE_MESSAGING_SOCKET: PRIVATE });

  const spawnWindow = async ({ home, data }: { home: string; data: string }) => {
    const win = await spawn('bob-agent', home, {
      [MESH_WINDOW_ENV]: WINDOW_TOKEN,
      CLAUDE_PLUGIN_DATA: data,
      CLAUDE_CODE_MESSAGING_SOCKET: WINDOW,
    });
    writeGuardStamp(data, new Date(), VERSION);
    expect(await activate(win, 'mesh window')).toContain('It is your mesh window.');
    return win;
  };

  beforeAll(async () => {
    hub = await createHub({
      loaded: testTeamConfig({
        mesh: { name: 'relay-e2e', prefix: PREFIX },
        hub: { http: { enabled: false }, tickSeconds: 1 },
      }),
      dataDir: ':memory:',
      nats: { servers: [NATS] },
      logger: createLogger('relay-hub', { level: 'warn', destination: 'stderr' }),
    });
    await hub.start();
  }, 30_000);

  afterEach(async () => {
    await Promise.all(agents.map((a) => a.client.close().catch(() => undefined)));
    agents = [];
    for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    temps = [];
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it('a reply to an inactive live owner reaches the window as a relay with forward_to', async () => {
    const bob = laptop();
    const [alice, priv] = await Promise.all([spawnAlice(), spawnPrivate(bob)]);
    const win = await spawnWindow(bob);
    const threadId = threadOf(
      await priv.call('ask', { to: 'alice-agent', text: 'Does the API send 409?' }),
    );
    const text = 'Yes, on a stale version.';
    const replyId = messageOf(
      await alice.call('reply', { thread_id: threadId, text, status: 'answer' }),
    );

    if (process.platform === 'win32') {
      const pointer = await win.waitFor((e) => e.meta.thread_id === threadId);
      expect(pointer.meta.kind).toBe('relay');
      expect(pointer.meta.forward_to).toBe(`uds:${PRIVATE}`);
      expect(pointer.meta.message_id).toBe(replyId);
      expect(pointer.content).toBe(
        pointerText({ from: 'alice-agent', threadId, messageId: replyId }),
      );
      // The guard's note: it passes exactly this one SendMessage.
      expect(existsSync(join(bob.data, forwardFile(PRIVATE_HEX, replyId) ?? ''))).toBe(true);
    } else {
      await quiet();
      expect(win.events.filter((e) => e.meta.thread_id === threadId)).toEqual([]);
    }

    await priv.call('peers', {});
    const record = await until(() =>
      readLocalSessions(bob.data, Date.now()).find((s) => s.threads === 1),
    );
    expect(record.from).toEqual(['alice-agent']);
    expect(hub.services.messaging.isRead('bob-agent', replyId)).toBe(false);
    expect(await priv.call('thread', { thread_id: threadId })).toContain(text);
    expect(hub.services.messaging.isRead('bob-agent', replyId)).toBe(true);
  }, 60_000);

  it('a closed private asker produces the notice and an orphan_decisions row', async () => {
    const bob = laptop();
    const [alice, priv] = await Promise.all([spawnAlice(), spawnPrivate(bob)]);
    const win = await spawnWindow(bob);
    const threadId = threadOf(
      await priv.call('ask', { to: 'alice-agent', text: 'Is the 409 body documented?' }),
    );
    const [own] = await until(() => {
      const found = readLocalSessions(bob.data, Date.now());
      return found.length ? found : undefined;
    });
    const sessionId = own?.hubSessionId ?? '';
    await priv.client.close();
    const { db } = hub.context;
    await until(() =>
      db.get(
        `SELECT 1 FROM sessions WHERE id = ? AND liveness = 'closed' AND private_at_close = 1`,
        [sessionId],
      ),
    );

    await alice.call('reply', {
      thread_id: threadId,
      text: 'Yes, in protocol.md.',
      status: 'answer',
    });
    const answer = await win.waitFor((e) => e.meta.thread_id === threadId && !!e.meta.asker);
    expect(answer.meta.asker).toBe('closed');
    expect(answer.content).toContain(`the session that asked this (${sessionId}) has closed`);
    const thread = internalId('thread', threadId);
    const rows = await until(() => {
      const found = db.all('SELECT agent_id FROM orphan_decisions WHERE thread_id = ?', [thread]);
      return found.length ? found : undefined;
    });
    expect(rows).toEqual([{ agent_id: 'bob-agent' }]);
    expect(
      db.all(`SELECT body FROM messages WHERE thread_id = ? AND kind = 'system'`, [thread]),
    ).toEqual([
      { body: "The session that asked this has closed; the follow-up waits for Bob's decision." },
    ]);
  }, 60_000);

  it("an owner's reply carries decidesFor", async () => {
    const [alice, win] = await Promise.all([spawnAlice(), spawnWindow(laptop())]);
    const threadId = threadOf(
      await alice.call('ask', { to: 'bob-agent', text: 'Can the client drop the v1 route?' }),
    );
    await win.waitFor((e) => e.meta.thread_id === threadId);
    hub.services.messaging.post({
      threadId: internalId('thread', threadId),
      senderId: 'bob',
      kind: 'reply',
      body: 'Yes, drop it.',
      to: ['bob-agent'],
    });
    const owner = await win.waitFor((e) => e.meta.thread_id === threadId && e.meta.from === 'bob');
    expect(owner.meta.decides).toBe('yes');
    expect(owner.content).toBe('│ Yes, drop it.');
  }, 60_000);
});
