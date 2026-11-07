import { type Logger, MeshError } from '@agentmesh/common';
import { MAX_REPORT_EVENTS, ReportedEvent } from '@agentmesh/protocol';
import type { HubClient } from '../hub';
import { collectEventFiles } from './events-file';
import type { Recorder } from './recorder';

/** An error-kind event sends early, but never sooner than this after the last send. */
const EARLY_MS = 2000;

/** How the hub's router answers a method it does not have: an older hub. */
const unknownMethod = (err: unknown): boolean =>
  err instanceof MeshError &&
  err.code === 'not_found' &&
  /^Unknown method|is not available on this hub/.test(err.message);

const valid = (e: unknown): boolean => ReportedEvent.safeParse(e).success;

export interface ShipperDeps {
  hub: Pick<HubClient, 'call'>;
  recorder: Recorder;
  /** The plugin data folder, where the guard and hook leave their events files. */
  dataDir: string;
  intervalMs: number;
  logger: Logger;
}

/**
 * Every `intervalMs`, collects the guard's and hook's files into the recorder and sends up to
 * MAX_REPORT_EVENTS events with `telemetry.report`. Events leave the buffer only once the hub
 * acknowledged them; a failed call puts them back for the next beat, with a debug log only. A
 * hub without the method stops it for this process. Returns the stop function.
 */
export function startShipper(deps: ShipperDeps): () => void {
  const { hub, recorder, dataDir, logger } = deps;
  let sending = false;
  let lastSend = 0;
  let early: NodeJS.Timeout | null = null;

  const send = async (events: ReportedEvent[]) => {
    try {
      const { accepted, dropped } = await hub.call('telemetry.report', { events });
      recorder.putBack(events.slice(accepted + dropped));
    } catch (err) {
      if (unknownMethod(err)) {
        stop();
        logger.info('this hub does not take telemetry.report; not reporting events');
        return;
      }
      // A batch the hub calls invalid never gets better; anything else goes again next beat.
      if (!(err instanceof MeshError && err.code === 'invalid_request')) recorder.putBack(events);
      logger.debug({ err }, 'could not ship events; retrying next beat');
    }
  };

  const ship = async () => {
    if (sending) return;
    sending = true;
    lastSend = Date.now();
    try {
      for (const value of collectEventFiles(dataDir)) {
        const parsed = ReportedEvent.safeParse(value);
        if (parsed.success) recorder.record(parsed.data);
      }
      // Checked here too: one malformed event must not hold up every batch behind it.
      const events = recorder.take(MAX_REPORT_EVENTS).filter(valid);
      if (events.length > 0) await send(events);
    } finally {
      sending = false;
    }
  };

  const timer = setInterval(() => void ship(), deps.intervalMs);
  timer.unref();
  recorder.onError = () => {
    if (early) return;
    early = setTimeout(
      () => {
        early = null;
        void ship();
      },
      Math.max(0, lastSend + EARLY_MS - Date.now()),
    );
    early.unref();
  };
  function stop(): void {
    clearInterval(timer);
    if (early) clearTimeout(early);
    early = null;
    recorder.onError = null;
  }
  return stop;
}
