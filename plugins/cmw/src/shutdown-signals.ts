/**
 * Closing a console window on Windows delivers SIGHUP (CTRL_CLOSE_EVENT); Ctrl+Break is
 * SIGBREAK. Both must say goodbye like SIGTERM, or the hub keeps the session for the grace period.
 */
export function shutdownSignals(platform: string): NodeJS.Signals[] {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  if (platform === 'win32') signals.push('SIGBREAK');
  return signals;
}

export function watchSignals(
  platform: string,
  target: { on(signal: NodeJS.Signals, handler: () => void): unknown },
  shutdown: (reason: string) => void,
): void {
  for (const signal of shutdownSignals(platform)) target.on(signal, () => shutdown(signal));
}

/** Runs `fn` on the first call only, so two signals send one `session.bye`. */
export function once<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    fn(...args);
  };
}
