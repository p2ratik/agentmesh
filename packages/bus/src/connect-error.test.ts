import { MeshError } from '@agentmesh/common';
import { describe, expect, it } from 'vitest';
import { refusedOrUnreachable } from './connect-error';

const HUB = 'tls://hub.example:4222';
const words = { refused: 'REFUSED.', dropped: 'DROPPED.' };
const fail = (message: string, code?: string) => Object.assign(new Error(message), { code });

describe('refusedOrUnreachable', () => {
  it('maps a refusal, a reset, a timeout and an unreachable hub without echoing the server', () => {
    const cases: Array<[Error, string, string]> = [
      [fail('Authorization Violation'), 'unauthenticated', 'REFUSED.'],
      // NATS closes on a refusal, so on Windows it can show as a reset before its -ERR is read.
      [fail('read ECONNRESET', 'ECONNRESET'), 'unauthenticated', 'DROPPED.'],
      [fail('TIMEOUT'), 'unauthenticated', 'DROPPED.'],
      [fail('connect ECONNREFUSED 127.0.0.1:4222', 'ECONNREFUSED'), 'unavailable', HUB],
      [fail('getaddrinfo ENOTFOUND hub.example'), 'unavailable', HUB],
      [fail('server does not support TLS'), 'unavailable', 'did not offer TLS'],
    ];
    for (const [error, code, text] of cases) {
      const mapped = refusedOrUnreachable(error, HUB, words);
      expect(mapped).toBeInstanceOf(MeshError);
      expect([mapped.code, mapped.message]).toEqual([code, expect.stringContaining(text)]);
      expect(mapped.message).not.toContain(error.message);
    }
  });

  // What nats.js really throws for a port nothing listens on: the code is only in the cause.
  it('reads a refused port from the error the NATS client throws', () => {
    const cause = fail('connect ECONNREFUSED 127.0.0.1:4222', 'ECONNREFUSED');
    const error = Object.assign(new Error('connection refused', { cause }), {
      name: 'ConnectionError',
    });
    const mapped = refusedOrUnreachable(error, HUB, words);
    expect([mapped.code, mapped.message]).toEqual([
      'unavailable',
      `Could not reach the hub at ${HUB}. Check your network and try again.`,
    ]);
  });

  it('gives the uncertain case the details its caller passes', () => {
    const details = { mayBeEnrolled: true };
    expect(refusedOrUnreachable(fail('read ECONNRESET'), HUB, words, details).details).toEqual(
      details,
    );
    expect(refusedOrUnreachable(fail('Authorization Violation'), HUB, words, details).details).toBe(
      undefined,
    );
  });
});
