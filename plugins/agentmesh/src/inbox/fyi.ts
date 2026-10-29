import type { SessionDelivery } from '@agentmesh/protocol';
import { EXTERNAL_TAG, LINE_BREAK, oneLine } from './render';

/** Most status items held for the next ride-along; older ones are dropped (and counted). */
const MAX_ITEMS = 50;

/** A ride-along taken from the buffer. */
export interface TakenFyi {
  /** Oldest first. */
  items: SessionDelivery[];
  /** The thread of each older item the cap dropped. */
  dropped: string[];
}

/**
 * Status deliveries waiting to ride along at the end of the next mesh tool
 * result or action push; they never start a turn on their own. No I/O: the
 * caller reports what it showed (`seenIds`) through `messages.seen`.
 */
export class FyiBuffer {
  #items: SessionDelivery[] = [];
  #dropped: string[] = [];

  /** Keeps the newest 50, dropping the oldest first. */
  add(messages: SessionDelivery[]): void {
    this.#items.push(...messages);
    const over = this.#items.length - MAX_ITEMS;
    if (over > 0) this.#dropped.push(...this.#items.splice(0, over).map((m) => m.threadId));
  }

  /** Empties the buffer. */
  take(): TakenFyi {
    const taken = { items: this.#items, dropped: this.#dropped };
    this.#items = [];
    this.#dropped = [];
    return taken;
  }

  /**
   * Puts back what a push that failed took, ahead of anything buffered since. Its
   * ids are already remembered as seen, so a redelivery would not buffer them again.
   */
  putBack(taken: TakenFyi): void {
    const since = this.take();
    this.#dropped = [...taken.dropped, ...since.dropped];
    this.add([...taken.items, ...since.items]);
  }
}

/** `FYI (n):` and one line per item, or '' when there is nothing. Pure. */
export function formatFyi({ items, dropped }: TakenFyi): string {
  if (items.length === 0) return '';
  const more = dropped.length > 0 ? [`· …and ${dropped.length} more: call inbox`] : [];
  return [`FYI (${items.length}):`, ...items.map(fyiLine), ...more].join('\n');
}

/**
 * The ids to report seen once shown. None from a thread that lost items to the
 * cap: the hub's cursor would pass those too, and "call inbox" would find nothing.
 */
export function seenIds({ items, dropped }: TakenFyi): string[] {
  const lost = new Set(dropped);
  return items.filter((m) => !lost.has(m.threadId)).map((m) => m.id);
}

/** The first non-blank line of `text`, at most `max` characters. */
export function firstLine(text: string, max: number): string {
  return (text.trim().split(LINE_BREAK)[0] ?? '').trim().slice(0, max);
}

/** True when an item the footer shows is external: the push carrying it is then external too. */
export const anyExternal = ({ items }: TakenFyi): boolean =>
  items.some((m) => m.trust === 'external');

/** An external item is tagged before its subject, which its text cannot reach past. */
function fyiLine(m: SessionDelivery): string {
  const tag = m.trust === 'external' ? `${EXTERNAL_TAG} ` : '';
  return `· ${m.threadId} ${tag}«${oneLine(m.subject).slice(0, 60)}» ${firstLine(m.body, 100)}`;
}
