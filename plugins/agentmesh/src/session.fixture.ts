import { connectBus, type NatsConnection } from '@agentmesh/bus';
import { createLogger } from '@agentmesh/common';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { vi } from 'vitest';

// Shared by the session tests; each test file mocks `@agentmesh/bus` so `connectBus` is a vi.fn.

const peer = {
  id: 'alice-agent',
  kind: 'agent',
  displayName: "Alice's Claude",
  owner: 'alice',
  status: 'online',
  statusNote: null,
  lastSeen: null,
  repo: null,
  branch: null,
  skills: [],
  areas: [],
  activeTasks: 0,
};

type Callback = (err: Error | null, msg: unknown) => void;

/**
 * A hub whose hellos hand out `ids` in order (one per hello); records each
 * hello's params, and the subscriptions, publishes and other requests (with
 * their session) in the order sent. Like the real hub, `session.check` sends a
 * check with code K7Q2ZP to the calling session's subject. `hello` adds fields
 * to later hellos' answers (`observability`, say); methods in `hang` never answer.
 */
export function fakeHub(ids: string[], unreadThreads = 0, reclaimed: string[] = []) {
  /** What later hellos answer in `policy` (older hubs send no closedAskerEscalationMinutes). */
  const policy: { closedAskerEscalationMinutes?: number } = {};
  const hello: Record<string, unknown> = {};
  const hang = new Set<string>();
  const hellos: Array<Record<string, unknown>> = [];
  const wire: string[] = [];
  /** The other requests' params: [subject, params]. */
  const sent: Array<[string, unknown]> = [];
  const listeners = new Map<string, Callback>();
  const answer = (result: unknown) => ({ json: () => ({ ok: true, result }) });
  const nc = {
    getServer: () => 'nats://hub.test:4222',
    publish: (subject: string, data: string) =>
      wire.push(`pub ${subject} ${JSON.parse(data).session}`),
    drain: async () => undefined,
    subscribe: (subject: string, opts: { callback: Callback }) => {
      wire.push(`sub ${subject}`);
      listeners.set(subject, opts.callback);
      return { unsubscribe: () => listeners.delete(subject) };
    },
    request: async (subject: string, data: string) => {
      const { params, session } = JSON.parse(data);
      if (!subject.endsWith('session.hello')) {
        wire.push(`req ${subject} ${session}`);
        sent.push([subject, params]);
        if ([...hang].some((method) => subject.endsWith(method))) return new Promise(() => {});
        if (subject.endsWith('telemetry.report')) {
          return answer({ accepted: params.events.length, dropped: 0 });
        }
        if (subject.endsWith('session.check')) {
          const check = { type: 'check', code: 'K7Q2ZP' };
          listeners.get(`mesh.session.alice-agent.${session}`)?.(null, {
            subject,
            json: () => check,
            respond: () => true,
          });
        }
        const view = { id: session, active: true, repo: null, branch: null, owns: [] };
        const { description } = params;
        if (subject.endsWith('session.activate')) return answer({ ...view, description });
        return answer({ ok: true });
      }
      hellos.push(params);
      return answer({
        self: peer,
        mesh: { name: 'acme', prefix: 'mesh' },
        policy: {
          instructions: '',
          git: {
            integrationBranch: 'agents',
            protectedBranches: ['main'],
            branchTemplate: 'agent/{owner}/{task}-{slug}',
            agentsMayMergeInto: ['agents'],
          },
          ...policy,
        },
        unreadThreads,
        sessionId: ids.shift(),
        reclaimed,
        ...hello,
      });
    },
  } as unknown as NatsConnection;
  vi.mocked(connectBus).mockResolvedValue(nc);
  return { hellos, wire, sent, listeners, policy, hello, hang };
}

/** The MCP server as startSession uses it: pushes, and the client info from the handshake. */
export function fakeServer() {
  const notification = vi.fn(async (_: unknown) => undefined);
  const getClientVersion = () => ({ name: 'claude-code', version: '2.1.319' });
  return { notification, server: { notification, getClientVersion } as unknown as Server };
}

export const logger = createLogger('test', { level: 'silent', destination: 'stderr' });
export const config = { agentId: 'alice-agent', servers: [], prefix: 'mesh', heartbeatSeconds: 30 };
export const pushes = (notification: ReturnType<typeof vi.fn>) =>
  notification.mock.calls.map(
    (call) => (call[0] as { params: { content: string; meta: Record<string, string> } }).params,
  );
