/** Purposes that borrow another channel when a team does not configure them. */
const FALLBACKS: Readonly<Record<string, string>> = { reviews: 'tasks', alerts: 'events' };

/**
 * The configured purpose to post to: itself, its fallback, or `events` for
 * anything unknown (e.g. a rule's custom notice channel). Null if none exist.
 */
export function resolvePurpose(purpose: string, available: ReadonlySet<string>): string | null {
  if (available.has(purpose)) return purpose;
  const fallback = FALLBACKS[purpose];
  if (fallback && available.has(fallback)) return fallback;
  return available.has('events') ? 'events' : null;
}

/** Purpose → Discord channel id, filled by provisioning at startup. */
export class ChannelDirectory {
  readonly #byPurpose: ReadonlyMap<string, string>;

  constructor(byPurpose: ReadonlyMap<string, string>) {
    this.#byPurpose = byPurpose;
  }

  channelFor(purpose: string): string | null {
    const resolved = resolvePurpose(purpose, new Set(this.#byPurpose.keys()));
    return resolved ? (this.#byPurpose.get(resolved) ?? null) : null;
  }

  /** Purpose of a channel id (used to recognise our own channels). */
  purposeOf(channelId: string): string | null {
    for (const [purpose, id] of this.#byPurpose) if (id === channelId) return purpose;
    return null;
  }
}
