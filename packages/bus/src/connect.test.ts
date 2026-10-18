import { describe, expect, it } from 'vitest';
import { generateUserKey, requiresTls, resolveSeed } from './connect';

describe('connect options', () => {
  it('requires TLS whenever a server URL says tls:// or wss://', () => {
    expect(requiresTls(['tls://hub.example.com:4222'])).toBe(true);
    expect(requiresTls(['nats://a:4222', ' TLS://b:4222'])).toBe(true);
    expect(requiresTls(['wss://hub.example.com'])).toBe(true);
    expect(requiresTls(['nats://hub.example.com:4222', 'localhost:4222'])).toBe(false);
  });

  it('generates a user key locally', () => {
    const key = generateUserKey();
    expect(key.publicKey).toMatch(/^U[A-Z2-7]{55}$/);
    expect(resolveSeed(key.seed)).toBe(key.seed);
  });
});
