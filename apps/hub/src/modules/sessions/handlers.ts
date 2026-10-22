import { MeshError } from '@agentmesh/common';
import type { HubContext } from '../../context';
import type {
  CallContext,
  MessagingService,
  PresenceService,
  RpcHandlerMap,
  SessionsService,
} from '../../contracts';
import { internalId, taskKey, threadKey } from '../../core/ids';
import { ActivationChecks } from './checks';
import type { SessionTransport } from './dispatcher';
import { isAtLeast, MIN_CLIENT_VERSION } from './version';

const UNREACHABLE =
  'The hub could not reach this session: nothing answered on its session subject. Likely ' +
  "causes: the hub's NATS permissions were not updated for plugin 0.2.0 (your mesh admin " +
  're-renders nats.conf and reloads NATS), or this Claude Code session was started without ' +
  'the channel flag (restart it with claude --dangerously-load-development-channels ' +
  'plugin:agentmesh@agentmesh). If the session only just started, try again in a few seconds.';

export interface SessionHandlerDeps {
  presence: PresenceService;
  messaging: MessagingService;
  locate(taskId: number): { threadId: number; repo: string | null } | null;
  /** Null without NATS: activation checks cannot reach any session. */
  transport: Pick<SessionTransport, 'check'> | null;
}

type SessionHandlers = Pick<
  RpcHandlerMap,
  | 'session.hello'
  | 'session.bye'
  | 'session.check'
  | 'session.activate'
  | 'session.deactivate'
  | 'session.describe'
  | 'session.take'
>;

/** The calling session, which the router verified belongs to the caller. */
function own(call: CallContext): string {
  if (!call.session) {
    throw new MeshError('invalid_request', `${call.method} needs the calling session; reconnect`);
  }
  return call.session;
}

function taskThread(deps: SessionHandlerDeps, raw: string): number {
  const taskId = internalId('task', raw);
  const found = deps.locate(taskId);
  if (!found) throw new MeshError('not_found', `Task ${taskKey(taskId)} not found`);
  return found.threadId;
}

export function sessionHandlers(
  ctx: HubContext,
  sessions: SessionsService,
  deps: SessionHandlerDeps,
): SessionHandlers {
  const { presence, messaging } = deps;
  const checks = new ActivationChecks();
  const now = () => ctx.clock.now().getTime();
  return {
    'session.hello': (params, call) => {
      const agentId = call.actor.id;
      const { clientVersion } = params;
      if (!isAtLeast(clientVersion, MIN_CLIENT_VERSION)) {
        ctx.logger.warn({ participant: agentId, clientVersion }, 'refused an outdated plugin');
        throw new MeshError(
          'invalid_request',
          `This AgentMesh plugin (${clientVersion}) is older than this hub needs ` +
            `(${MIN_CLIENT_VERSION}). Update it: ` +
            'claude plugin update agentmesh@agentmesh, then restart Claude Code.',
        );
      }
      presence.touch(agentId, { repo: params.repo, branch: params.branch });
      const { session, reclaimed } = sessions.open(agentId, params);
      ctx.logger.info(
        { participant: agentId, clientVersion, session: session.id },
        'session hello',
      );
      const { config } = ctx.loaded;
      return {
        self: presence.peer(agentId),
        mesh: { name: config.mesh.name, prefix: config.mesh.prefix },
        policy: { instructions: ctx.loaded.policyText, git: config.git },
        unreadThreads: messaging.unreadThreadCount(agentId),
        sessionId: session.id,
        reclaimed: reclaimed.map(threadKey),
      };
    },
    /** The participant goes offline only with its last live session. */
    'session.bye': (_params, call) => {
      const agentId = call.actor.id;
      if (call.session) sessions.close(agentId, call.session);
      if (!sessions.hasLiveSession(agentId)) presence.markOffline(agentId);
      return { ok: true };
    },
    /** The spec's test message: its code reaches Claude only through this session's push. */
    'session.check': async (_params, call) => {
      const session = own(call);
      if (!deps.transport) throw new MeshError('unavailable', 'This hub has no NATS connection.');
      try {
        await deps.transport.check(call.actor.id, session, checks.issue(session, now()));
      } catch (err) {
        ctx.logger.warn({ agent: call.actor.id, session, err }, 'activation check got no answer');
        throw new MeshError('unavailable', UNREACHABLE);
      }
      return { ok: true };
    },
    'session.activate': (params, call) => {
      const session = own(call);
      checks.confirm(session, params.code, now());
      sessions.activate(call.actor.id, session, params.description);
      return sessions.view(session);
    },
    'session.deactivate': (_params, call) => {
      const session = own(call);
      sessions.deactivate(call.actor.id, session);
      return sessions.view(session);
    },
    'session.describe': (params, call) => {
      const session = own(call);
      sessions.describe(call.actor.id, session, params.description);
      return sessions.view(session);
    },
    'session.take': (params, call) => {
      const threadId = params.threadId
        ? internalId('thread', params.threadId)
        : taskThread(deps, params.taskId ?? '');
      const { previous } = sessions.take(call.actor.id, own(call), threadId);
      return { threadId: threadKey(threadId), previousSession: previous };
    },
  };
}
