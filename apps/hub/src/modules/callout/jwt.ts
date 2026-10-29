import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { fromPublic, type KeyPair } from '@nats-io/nkeys';
import { Codec } from '@nats-io/nkeys/lib/codec.js';

/**
 * NATS JWTs are plain JWTs signed with an nkey (ed25519); no JWT library is
 * needed. See docs/specs/auth-callout-spike.md (c). Signing and verifying go
 * through node:crypto: nkeys' pure-JS ed25519 takes ~8 ms per operation, and
 * every connect, even a bogus one, needs three (docs/security.md).
 */
const b64 = (data: string | Uint8Array): string => Buffer.from(data).toString('base64url');
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const HEADER = b64(JSON.stringify({ typ: 'JWT', alg: 'ed25519-nkey' }));

export type Claims = Record<string, unknown>;

/** An ed25519 key as node:crypto imports it; `d` (the 32-byte seed) only for a private key. */
const jwk = (x: Uint8Array, d?: Uint8Array) => ({
  key: { kty: 'OKP', crv: 'Ed25519', x: b64(x), ...(d ? { d: b64(d) } : {}) },
  format: 'jwk' as const,
});

/** The raw ed25519 key inside a public nkey (U…, A…, N…); throws on a bad prefix or checksum. */
function rawPublicKey(nkey: string): Uint8Array {
  fromPublic(nkey);
  return Codec._decode(utf8(nkey)).subarray(1);
}

/** Built once per issuer: deriving its public half goes through nkeys' slow ed25519. */
const privateKeys = new WeakMap<KeyPair, KeyObject>();
function privateKey(kp: KeyPair): KeyObject {
  let key = privateKeys.get(kp);
  if (!key) {
    key = createPrivateKey(
      jwk(rawPublicKey(kp.getPublicKey()), Codec.decodeSeed(kp.getSeed()).buf),
    );
    privateKeys.set(kp, key);
  }
  return key;
}

/** Whether `sig` (base64url) is `nkey`'s ed25519 signature over `data`. */
function verifies(nkey: string, data: string, sig: string): boolean {
  try {
    const key = createPublicKey(jwk(rawPublicKey(nkey)));
    return verify(null, utf8(data), key, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

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
  const signed = `${HEADER}.${payload}`;
  return `${signed}.${b64(sign(null, utf8(signed), privateKey(issuer)))}`;
}

export interface ParsedJwt {
  claims: Claims & { iss: string };
  signed: string;
  sig: string;
}

/** A JWT's claims before any signature check; null when it is not a well-formed nkey JWT. */
export function parseJwt(jwt: string): ParsedJwt | null {
  const [head, payload, sig, extra] = jwt.split('.');
  if (!head || !payload || !sig || extra !== undefined) return null;
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as Claims;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
    if (header?.alg !== 'ed25519-nkey' || typeof claims?.iss !== 'string') return null;
    return { claims: claims as ParsedJwt['claims'], signed: `${head}.${payload}`, sig };
  } catch {
    return null;
  }
}

/** Whether a parsed JWT is signed by the key in its own `iss`. */
export function signedByIssuer(jwt: ParsedJwt): boolean {
  return verifies(jwt.claims.iss, jwt.signed, jwt.sig);
}

/** The claims of a JWT signed by the key in its own `iss`, or null for anything else. */
export function verifiedClaims(jwt: string): Claims | null {
  const parsed = parseJwt(jwt);
  return parsed && signedByIssuer(parsed) ? parsed.claims : null;
}

/** Whether `sig` (base64url) is `nkey`'s signature over the server's nonce. */
export function signedNonce(nkey: string, nonce: string, sig: string): boolean {
  return nkey.startsWith('U') && verifies(nkey, nonce, sig);
}
