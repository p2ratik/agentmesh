import { randomBytes } from 'node:crypto';
import { fromPublic, type KeyPair } from '@nats-io/nkeys';

/**
 * NATS JWTs are plain JWTs signed with an nkey (ed25519); no JWT library is
 * needed. See docs/specs/auth-callout-spike.md (c).
 */
const b64 = (data: string | Uint8Array): string => Buffer.from(data).toString('base64url');
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const HEADER = b64(JSON.stringify({ typ: 'JWT', alg: 'ed25519-nkey' }));

export type Claims = Record<string, unknown>;

/** Signs `claims` with the issuer key; fills in `jti`, `iat` and `iss`. */
export function signJwt(issuer: KeyPair, claims: Claims, now: Date): string {
  const payload = b64(
    JSON.stringify({
      jti: randomBytes(16).toString('base64url'),
      iat: Math.floor(now.getTime() / 1000),
      iss: issuer.getPublicKey(),
      ...claims,
    }),
  );
  return `${HEADER}.${payload}.${b64(issuer.sign(utf8(`${HEADER}.${payload}`)))}`;
}

/** The claims of a JWT signed by the key in its own `iss`, or null for anything else. */
export function verifiedClaims(jwt: string): Claims | null {
  const [head, payload, sig, extra] = jwt.split('.');
  if (!head || !payload || !sig || extra !== undefined) return null;
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as Claims;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
    if (header.alg !== 'ed25519-nkey' || typeof claims.iss !== 'string') return null;
    const valid = fromPublic(claims.iss).verify(
      utf8(`${head}.${payload}`),
      Buffer.from(sig, 'base64url'),
    );
    return valid ? claims : null;
  } catch {
    return null;
  }
}

/** Whether `sig` (base64url) is `nkey`'s signature over the server's nonce. */
export function signedNonce(nkey: string, nonce: string, sig: string): boolean {
  if (!nkey.startsWith('U')) return false;
  try {
    return fromPublic(nkey).verify(utf8(nonce), Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}
