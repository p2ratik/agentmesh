import type { CallOptions } from '@agentmesh/bus';
import { type Logger, MeshError } from '@agentmesh/common';
import { MAX_REPORT_EVENTS, ReportedEvent } from '@agentmesh/protocol';
import type { HubClient } from '../hub';
import { collectEventFiles } from './events-file';
import { recordExpired } from './plugin-events';
import type { Recorder } from './recorder';

/** An error-kind event sends early, but never sooner than this after the last send. */
const EARLY_MS = 2000;
/** The longest the last report on shutdown waits; the bye gets the rest of the budget. */
export const FLUSH_MS = 100;

/** How the hub's router answers a method it does not have: an older hub. */
const unknownMethod = (err: unknown): boolean =>
  err instanceof MeshError &&
  err.code === 'not_found' &&
  /^Unknown method|is not available on this hub/.test(err.message);

const valid = (e: unknown): boolean => ReportedEvent.safeParse(e).success;

export interface ShipperDeps {
  /** Its session says the hub answered a hello: until then nothing is collected or sent. */
  hub: Pick<HubClient, 'call' | 'sessionId'>;
  recorder: Recorder;
  /** The plugin data folder, where the guard and hook leave their events files. */
  dataDir: string;
  intervalMs: number;
  logger: Logger;
  /** The mesh window: it reports the forward records that expired unclaimed. */
  relayExpiry: boolean;
}

/**
 * Every `intervalMs`, collects the guard's and hook's files into the recorder and sends up to
 * MAX_REPORT_EVENTS events with `telemetry.report`. Events leave the buffer only once the hub
 * acknowledged them; a failed call puts them back for the next beat, with a debug log only. A
 * hub without the method stops it, and the recorder, for this process. Events that fail
 * validation count as dropped. The returned stop sends one last report, waiting at most FLUSH_MS.
 */
export function startShipper(deps: ShipperDeps): () => Promise<void> {
  const { hub, recorder, dataDir, intervalMs, logger, relayExpiry } = deps;
  let halted = false;
  let sending = false;
  /** An early send came due while another send was out: it goes once that one ends. */
  let missedEarly = false;
  let lastSend = 0;
  let early: NodeJS.Timeout | null = null;

  const send = async (events: ReportedEvent[], options: CallOptions) => {
    try {
      const { accepted, dropped } = await hub.call('telemetry.report', { events }, options);
      recorder.putBack(events.slice(accepted + dropped));
    } catch (err) {
      if (unknownMethod(err)) {
        halt();
        recorder.off();
        logger.info('this hub does not take telemetry.report; not reporting events');
        return;
      }
      // A batch the hub calls invalid never gets better; anything else goes again next beat.
      if (!(err instanceof MeshError && err.code === 'invalid_request')) recorder.putBack(events);
      logger.debug({ err }, 'could not ship events; retrying next beat');
    }
  };

  /** Up to MAX_REPORT_EVENTS events; one that fails validation counts as dropped. */
  const batch = () => {
    const taken = recorder.take(MAX_REPORT_EVENTS);
    const events = taken.filter(valid);
    recorder.countDropped(taken.length - events.length);
    return events;
  };

  const ship = async () => {
    if (halted || sending || !hub.sessionId) return;
    sending = true;
    lastSend = Date.now();
    try {
      let bad = 0;
      for (const value of collectEventFiles(dataDir)) {
        const parsed = ReportedEvent.safeParse(value);
        if (parsed.success) recorder.record(parsed.data);
        else bad += 1;
      }
      recorder.countDropped(bad);
      if (relayExpiry) recordExpired(recorder, hub.sessionId, dataDir);
      const events = batch();
      if (events.length > 0) await send(events, { timeoutMs: intervalMs });
    } finally {
      sending = false;
      if (missedEarly) {
        missedEarly = false;
        armEarly();
      }
    }
  };

  function armEarly(): void {
    if (early || halted) return;
    const due = () => {
      early = null;
      if (sending) missedEarly = true;
      else void ship();
    };
    early = setTimeout(due, Math.max(0, lastSend + EARLY_MS - Date.now()));
    early.unref();
  }

  function halt(): void {
    halted = true;
    clearInterval(timer);
    if (early) clearTimeout(early);
    early = null;
    recorder.onError = null;
  }

  const timer = setInterval(() => void ship(), intervalMs);
  timer.unref();
  recorder.onError = armEarly;

  return async () => {
    halt();
    // The report needs the live session: the caller says bye only after this.
    const session = hub.sessionId;
    if (!session) return;
    const events = batch();
    if (events.length === 0) return;
    await Promise.race([
      send(events, { session, timeoutMs: FLUSH_MS }),
      new Promise((resolve) => setTimeout(resolve, FLUSH_MS)),
    ]);
  };
}
