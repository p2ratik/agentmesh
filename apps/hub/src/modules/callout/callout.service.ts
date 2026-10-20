import { APP_ACCOUNT, type NatsConnection, permissionsFor } from '@agentmesh/bus';
import { MINUTE_MS } from '@agentmesh/common';
import type { KeyPair } from '@nats-io/nkeys';
import type { HubContext } from '../../context';
import type { EnrollmentService } from '../../contracts';
import { type AuthRequest, type Decision, decide, serverRequest } from './decide';
import { signJwt, verifiedClaims } from './jwt';
import { FailureLimiter } from './limiter';
import { RefusalLog } from './refusals';

/** The server's auth requests arrive here (docs/specs/auth-callout-spike.md). */
export const AUTH_CALLOUT_SUBJECT = '$SYS.REQ.USER.AUTH';
const XKEY_HEADER = 'Nats-Server-Xkey';
/** What a refused client's server log shows. Never the reason, never the token. */
const REFUSAL = 'not authorized';
/** Connections remembered per agent for kicks; a reconnect loop must not grow it forever. */
const MAX_TRACKED = 16;
/** Repeated refusals of one key within this window are logged at debug (see RefusalLog). */
const REFUSAL_LOG_WINDOW_MS = 10 * MINUTE_MS;

export interface CalloutKeys {
  /** Account key (A…) that signs responses and user JWTs; its public key is `issuer` in nats.conf. */
  issuer: KeyPair;
  /** Curve key (X…) that opens sealed requests and seals responses. */
  xkey: KeyPair;
}

interface AuthMsg {
  data: Uint8Array;
  headers?: { get(name: string): string } | undefined;
  respond(data: Uint8Array): boolean;
}

/**
 * The hub's NATS auth callout. Static users (hub, services) never reach it;
 * every agent connect does. Anything unexpected is refused or left
 * unanswered, which nats-server also treats as a refusal.
 */
export class CalloutService {
  readonly #ctx: HubContext;
  readonly #keys: CalloutKeys;
  readonly #enrollment: EnrollmentService;
  readonly #sys: NatsConnection;
  readonly #limiter: FailureLimiter;
  readonly #refusals: RefusalLog;
  // ponytail: in memory, so connections from before a hub restart cannot be kicked; the user
  // JWT's exp (enrollment.userJwtTtlMinutes) ends them. Query CONNZ if that is ever too slow.
  readonly #connections = new Map<string, Array<{ serverId: string; cid: number }>>();

  constructor(
    ctx: HubContext,
    deps: { keys: CalloutKeys; enrollment: EnrollmentService; sys: NatsConnection },
  ) {
    this.#ctx = ctx;
    this.#keys = deps.keys;
    this.#enrollment = deps.enrollment;
    this.#sys = deps.sys;
    this.#limiter = new FailureLimiter(
      ctx.loaded.config.enrollment.redeemAttemptsPerMinute,
      ctx.clock,
    );
    this.#refusals = new RefusalLog(REFUSAL_LOG_WINDOW_MS, ctx.clock);
  }

  /** Answers auth requests on the hub's own (static, unrestricted) connection. */
  start(nc: NatsConnection): ReturnType<NatsConnection['subscribe']> {
    return nc.subscribe(AUTH_CALLOUT_SUBJECT, {
      callback: (err, msg) => {
        if (err) {
          this.#ctx.logger.error({ err }, 'auth callout subscription failed');
          return;
        }
        this.handle(msg).catch((error: unknown) => {
          this.#ctx.logger.error({ err: error }, 'auth callout failed; the connect is refused');
        });
      },
    });
  }

  async handle(msg: AuthMsg): Promise<void> {
    const serverXkey = msg.headers?.get(XKEY_HEADER);
    const opened = serverXkey ? this.#keys.xkey.open(msg.data, serverXkey) : null;
    if (!serverXkey || !opened) {
      this.#ctx.logger.warn('unsealed or unreadable auth request: is xkey set in nats.conf?');
      return;
    }
    const request = serverRequest(verifiedClaims(new TextDecoder().decode(opened)));
    if (!request) {
      this.#ctx.logger.warn('auth request not signed by the server; ignored');
      return;
    }
    const decision = await this.#decide(request);
    const now = this.#ctx.clock.now();
    const answer =
      'agentId' in decision
        ? { jwt: this.#userJwt(request, decision.agentId, now) }
        : { error: REFUSAL };
    if ('agentId' in decision) {
      this.#track(decision.agentId, request);
      this.#ctx.logger.info(
        { agentId: decision.agentId, cid: request.client_info?.id },
        'agent admitted',
      );
    } else {
      // Keyed by the client's own nkey: plugins retry a refused connect every few seconds.
      const key = `${request.connect_opts?.nkey ?? request.client_info?.host}|${decision.refused}`;
      const { level, repeated } = this.#refusals.note(key);
      this.#ctx.logger[level](
        {
          reason: decision.refused,
          nkey: request.connect_opts?.nkey,
          host: request.client_info?.host,
          cid: request.client_info?.id,
          ...(repeated ? { repeatedSinceLastWarning: repeated } : {}),
        },
        'agent refused',
      );
    }
    const response = signJwt(
      this.#keys.issuer,
      {
        sub: request.user_nkey,
        aud: request.server_id.id,
        nats: { type: 'authorization_response', version: 2, ...answer },
      },
      now,
    );
    msg.respond(this.#keys.xkey.seal(new TextEncoder().encode(response), serverXkey));
  }

  /** Disconnects every connection the agent was admitted on. Revoke it first. */
  async kick(agentId: string): Promise<void> {
    const connections = this.#connections.get(agentId) ?? [];
    this.#connections.delete(agentId);
    await Promise.all(
      connections.map(({ serverId, cid }) =>
        this.#sys
          .request(`$SYS.REQ.SERVER.${serverId}.KICK`, JSON.stringify({ cid }), { timeout: 2000 })
          .catch((err: unknown) => {
            // A stale server id or a closed connection: nothing left to kick.
            this.#ctx.logger.warn({ err, agentId, cid }, 'kick not confirmed');
          }),
      ),
    );
    if (connections.length > 0)
      this.#ctx.logger.info({ agentId, connections: connections.length }, 'agent kicked');
  }

  #decide(request: AuthRequest): Promise<Decision> {
    return decide(request, {
      agentForKey: (nkey) => this.#ctx.index.agents().find((a) => a.nkey === nkey)?.id ?? null,
      redeem: (input) => this.#enrollment.redeem(input),
      limiter: this.#limiter,
    });
  }

  #userJwt(request: AuthRequest, agentId: string, now: Date): string {
    const { config } = this.#ctx.index;
    const perms = permissionsFor({ id: agentId, kind: 'agent' }, config.mesh.prefix);
    const ttl = config.enrollment.userJwtTtlMinutes * MINUTE_MS;
    return signJwt(
      this.#keys.issuer,
      {
        sub: request.user_nkey,
        aud: APP_ACCOUNT,
        name: agentId,
        exp: Math.floor((now.getTime() + ttl) / 1000),
        nats: {
          type: 'user',
          version: 2,
          pub: { allow: perms.publish },
          sub: { allow: perms.subscribe },
        },
      },
      now,
    );
  }

  #track(agentId: string, request: AuthRequest): void {
    const cid = request.client_info?.id;
    if (cid === undefined) return;
    const list = this.#connections.get(agentId) ?? [];
    list.push({ serverId: request.server_id.id, cid });
    this.#connections.set(agentId, list.slice(-MAX_TRACKED));
  }
}
