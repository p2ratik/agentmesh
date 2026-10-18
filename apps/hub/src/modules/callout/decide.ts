import { decodeInvite, type MemberRecord } from '@agentmesh/protocol';
import type { RedeemInput } from '../../contracts';
import { type Claims, signedNonce } from './jwt';
import type { FailureLimiter } from './limiter';

/** The `nats` claim of an authorization request, as nats-server 2.15 sends it. */
export interface AuthRequest {
  server_id: { id: string };
  user_nkey: string;
  client_info?: { host?: string; id?: number; nonce?: string };
  connect_opts?: { nkey?: string; sig?: string; auth_token?: string };
}

export interface DecideDeps {
  /** The agent that holds this key in mesh.yaml or the registry (active members only). */
  agentForKey(nkey: string): string | null;
  redeem(input: RedeemInput): Promise<MemberRecord>;
  limiter: FailureLimiter;
}

/** Who to admit, or why not. The reason is for the hub log only, never the response. */
export type Decision = { agentId: string } | { refused: string };

/** The request inside a verified JWT, when the server itself signed it. */
export function serverRequest(claims: Claims | null): AuthRequest | null {
  const request = claims?.nats as AuthRequest | undefined;
  if (!request?.server_id?.id || typeof request.user_nkey !== 'string') return null;
  // xkey hides the request but anyone can seal to it: the signature proves the sender.
  return claims?.iss === request.server_id.id ? request : null;
}

/**
 * Decides one connect. Order matters: the signature first (nats-server does
 * not check it under auth callout), then a known key, then an invite.
 */
export async function decide(request: AuthRequest, deps: DecideDeps): Promise<Decision> {
  const { nkey, sig, auth_token: token } = request.connect_opts ?? {};
  const nonce = request.client_info?.nonce;
  if (!nkey || !sig || !nonce) return { refused: 'no nkey signature' };
  if (!signedNonce(nkey, nonce, sig)) return { refused: 'bad nkey signature' };

  const known = deps.agentForKey(nkey);
  if (known) return { agentId: known };
  if (!token) return { refused: 'unknown key' };

  const ip = `ip:${request.client_info?.host ?? 'unknown'}`;
  if (deps.limiter.blocked(ip)) return { refused: 'too many failed redemptions from this address' };
  let invite: ReturnType<typeof decodeInvite>;
  try {
    invite = decodeInvite(token);
  } catch {
    deps.limiter.fail(ip);
    return { refused: 'malformed invite' };
  }
  const perInvite = `invite:${invite.inviteId}`;
  if (deps.limiter.blocked(perInvite)) return { refused: 'too many failed redemptions' };
  try {
    const member = await deps.redeem({ inviteId: invite.inviteId, secret: invite.secret, nkey });
    return { agentId: member.agentId };
  } catch {
    deps.limiter.fail(ip);
    deps.limiter.fail(perInvite);
    return { refused: 'invite refused' };
  }
}
