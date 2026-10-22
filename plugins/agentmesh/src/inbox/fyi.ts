import type { SessionDelivery } from '@agentmesh/protocol';
import { oneLine } from './render';

/** Most status items held for the next ride-along; older ones are dropped (and counted). */
const MAX_ITEMS = 50;

/** A ride-along: one line per item, the ids to report as seen, and how many were dropped. */
export interface TakenFyi {
  lines: string[];
  ids: string[];
  dropped: number;
}

/**
 * Status deliveries waiting to ride along at the end of the next mesh tool
 * result or action push; they never start a turn on their own. No I/O: the
 * caller reports what it showed through `messages.seen`.
 */
export class FyiBuffer {
  #items: SessionDelivery[] = [];
  #dropped = 0;

  /** Keeps the newest 50, dropping the oldest first. */
  add(messages: SessionDelivery[]): void {
    this.#items.push(...messages);
    const over = this.#items.length - MAX_ITEMS;
    if (over <= 0) return;
    this.#items.splice(0, over);
    this.#dropped += over;
  }

  /** Empties the buffer. */
  take(): TakenFyi {
    const items = this.#items;
    const taken = {
      lines: items.map(fyiLine),
      ids: items.map((m) => m.id),
      dropped: this.#dropped,
    };
    this.#items = [];
    this.#dropped = 0;
    return taken;
  }
}

/** `FYI (n):` and one line per item, or '' when there is nothing. Pure. */
export function formatFyi(taken: TakenFyi): string {
  if (taken.lines.length === 0) return '';
  const more = taken.dropped > 0 ? [`· …and ${taken.dropped} more: call inbox`] : [];
  return [`FYI (${taken.lines.length}):`, ...taken.lines, ...more].join('\n');
}

/** The first non-blank line of `text`, at most `max` characters. */
export function firstLine(text: string, max: number): string {
  return (text.trim().split('\n')[0] ?? '').trim().slice(0, max);
}

function fyiLine(m: SessionDelivery): string {
  return `· ${m.threadId} «${oneLine(m.subject).slice(0, 60)}» ${firstLine(m.body, 100)}`;
}
