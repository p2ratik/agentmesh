import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IngestAuth } from '@agentmesh/config';

export type Headers = Record<string, string | string[] | undefined>;

export function header(headers: Headers, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Constant-time comparison that is also safe for inputs of different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Checks a request against its source's auth: bearer token, HMAC signature, or none. */
export function verifyIngestAuth(auth: IngestAuth, headers: Headers, rawBody: Buffer): boolean {
  if (auth.type === 'none') return true;
  if (auth.type === 'bearer') {
    const value = header(headers, 'authorization') ?? '';
    const token = value.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : '';
    return token.length > 0 && safeEqual(token, auth.token);
  }
  const signature = header(headers, auth.header) ?? '';
  const expected = auth.prefix + createHmac('sha256', auth.secret).update(rawBody).digest('hex');
  return signature.length > 0 && safeEqual(signature, expected);
}
