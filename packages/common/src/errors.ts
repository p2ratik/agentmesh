/**
 * Error codes shared by every component. They travel over the wire in RPC
 * responses, so treat them as part of the public protocol.
 */
export const ERROR_CODES = [
  'invalid_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'invalid_transition',
  'rate_limited',
  'loop_detected',
  'duplicate',
  'paused',
  'unavailable',
  'timeout',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class MeshError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MeshError';
    this.code = code;
    this.details = details;
  }

  toPayload(): ErrorPayload {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }

  static fromPayload(payload: ErrorPayload): MeshError {
    return new MeshError(payload.code, payload.message, payload.details);
  }
}

export function isMeshError(value: unknown): value is MeshError {
  return value instanceof MeshError;
}

/** Normalizes anything thrown into a wire-safe payload without leaking stack traces. */
export function toErrorPayload(error: unknown): ErrorPayload {
  if (isMeshError(error)) return error.toPayload();
  return { code: 'internal', message: 'Internal error' };
}

export const meshErrors = {
  invalid: (message: string, details?: Record<string, unknown>) =>
    new MeshError('invalid_request', message, details),
  notFound: (what: string, id: string) => new MeshError('not_found', `${what} ${id} not found`),
  forbidden: (message: string) => new MeshError('forbidden', message),
  conflict: (message: string, details?: Record<string, unknown>) =>
    new MeshError('conflict', message, details),
};
