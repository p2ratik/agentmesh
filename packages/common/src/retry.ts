export interface RetryOptions {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export function backoffDelay(attempt: number, options: RetryOptions = {}): number {
  const initial = options.initialDelayMs ?? 500;
  const max = options.maxDelayMs ?? 30_000;
  const factor = options.factor ?? 2;
  return Math.min(max, initial * factor ** Math.max(0, attempt - 1));
}

/** Retries `fn` with exponential backoff. `attempts: Infinity` retries forever. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 5;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || options.signal?.aborted) throw error;
      const delay = backoffDelay(attempt, options);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay, options.signal);
    }
  }
}
