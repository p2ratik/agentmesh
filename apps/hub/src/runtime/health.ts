/**
 * Readiness: whether the hub can serve agents right now. `GET /healthz` reports it, Docker's
 * healthcheck and the deploy script's gate read it, and a failing check makes a deploy roll back
 * (docs/deploy.md#automatic-deploys). The report holds booleans only, never an error text: it is
 * served without authentication.
 */
export interface HealthReport {
  ok: boolean;
  checks: {
    /** `start()` finished and `stop()` has not begun. */
    started: boolean;
    /** The database answers a query. */
    db: boolean;
    /** A round trip to the NATS server completes in time (true when the hub runs without NATS). */
    nats: boolean;
    /** The RPC, presence and callout subscriptions are open. */
    subscriptions: boolean;
  };
}

export interface HealthProbes {
  started(): boolean;
  /** Throws when the database does not answer. */
  db(): void;
  /** A NATS round trip, or null when the hub runs without NATS. */
  natsRoundTrip(): Promise<unknown> | null;
  subscriptionsOpen(): boolean;
}

/** A wedged connection must not hold the probe longer than Docker's healthcheck timeout (5 s). */
export const NATS_PROBE_TIMEOUT_MS = 2_000;

async function within(probe: Promise<unknown> | null, timeoutMs: number): Promise<boolean> {
  if (!probe) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([probe.then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHealth(
  probes: HealthProbes,
  timeoutMs = NATS_PROBE_TIMEOUT_MS,
): Promise<HealthReport> {
  let db = true;
  try {
    probes.db();
  } catch {
    db = false;
  }
  let natsProbe: Promise<unknown> | null;
  try {
    natsProbe = probes.natsRoundTrip();
  } catch (err) {
    natsProbe = Promise.reject(err);
  }
  const checks = {
    started: probes.started(),
    db,
    nats: await within(natsProbe, timeoutMs),
    subscriptions: probes.subscriptionsOpen(),
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}
