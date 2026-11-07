import type { ObservedEvent } from '@agentmesh/protocol';

const pad2 = (n: number) => String(n).padStart(2, '0');
const shortMsg = (id: string) => `msg-…${id.slice(-4)}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const SKEW_MIN_MS = 120_000;

/** Local date, time and UTC offset (minutes) of an instant, in the process zone at that instant. */
function local(iso: string): { date: string; time: string; off: number } {
  const ms = Date.parse(iso);
  const off = -new Date(ms).getTimezoneOffset();
  const text = new Date(ms + off * 60_000).toISOString();
  return { date: text.slice(0, 10), time: text.slice(11, 19), off };
}

function offsetLabel(off: number): string {
  const abs = Math.abs(off);
  return `UTC${off < 0 ? '-' : '+'}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

// Delivery stages in journey order: [key, words]. The first matching ENDINGS entry says why it stopped.
const STEPS: Array<[string, string]> = [
  ['hub:sent', 'hub sent'],
  ['hub:failed', 'hub failed'],
  ['hub:no_session', 'hub found no session'],
  ['plugin:received', 'plugin got it'],
  ['plugin:deduped', 'duplicate'],
  ['plugin:held', 'held'],
  ['plugin:push_failed', 'push failed'],
  ['plugin:pushed', 'pushed to Claude'],
];
const ENDINGS: Array<[string, string]> = [
  ['hub:failed', 'hub failed'],
  ['hub:no_session', 'no session'],
  ['plugin:push_failed', 'push failed'],
  ['plugin:held', 'held'],
  ['plugin:deduped', 'duplicate'],
  ['plugin:received', 'not pushed'],
  ['hub:sent', 'not received'],
];

/** Plugin and hub delivery events for one message id, folded into one journey. */
function journey(group: ObservedEvent[]): string {
  const stages = new Set<string>();
  let ms = 0;
  let head = '';
  for (const e of group) {
    if (e.kind !== 'delivery') continue;
    head = `${e.thread} ${shortMsg(e.message)}`;
    stages.add(`${e.source === 'hub' ? 'hub' : 'plugin'}:${e.stage}`);
    if ('sinceReceivedMs' in e && e.stage === 'pushed') ms = e.sinceReceivedMs;
  }
  if (stages.has('hub:acked')) stages.add('hub:sent');
  const steps = STEPS.filter(([key]) => stages.has(key)).map(([, words]) => words);
  const chain = `${head}  ${steps.join(' → ')}`;
  if (stages.has('plugin:pushed')) return `${chain} ✓ ${seconds(ms)}`;
  const end = ENDINGS.find(([key]) => stages.has(key))?.[1] ?? 'incomplete';
  return `${chain} ✗ (${end})`;
}

/** ` · text` when there is text. */
const opt = (v: string | number | undefined | null, pre = ' · ') =>
  v === undefined || v === null || v === '' ? '' : `${pre}${v}`;

function sessionDetails(
  e: Extract<ObservedEvent, { source: 'plugin' | 'guard' | 'hook' }>,
): string {
  switch (e.kind) {
    case 'connected':
      return `${e.session ?? 'no session'}${e.meshWindow ? ' (mesh window)' : ''}${e.pull ? ' (pull)' : ''}`;
    case 'nats':
      return `NATS ${e.event}${opt(e.code, ' ')}`;
    case 'activation':
      return `${e.phase} · ${e.mode}${opt(e.reason)}`;
    case 'tool':
      return `${e.tool} ${e.outcome} ${e.ms}ms${opt(e.thread, ' ')}`;
    case 'guard': {
      const deny = e.decision === 'deny';
      return `guard ${deny ? 'denied' : 'asked'}: ${e.reason}${e.key ? ` (${e.key})` : ''}${deny ? ' ✗' : ''}`;
    }
    case 'hook':
      return `${e.note}${e.unread === undefined ? '' : ` · ${e.unread} unread`}`;
    case 'dropped':
      return `${e.count} events dropped`;
    default:
      return e.kind;
  }
}

/** One non-delivery event (deliveries are folded by the caller). */
function details(e: ObservedEvent): string {
  switch (e.kind) {
    case 'session':
      return `${e.phase}${e.replacedSession ? ` (replaced ${e.replacedSession})` : ''}`;
    case 'relay':
      return `${e.thread} ${shortMsg(e.message)}  ${e.source === 'hub' ? 'hub' : 'plugin'} ${e.stage}${opt(e.reason)}`;
    case 'orphan':
      return `${e.thread} ${e.phase}`;
    case 'rpc':
      return `${e.method} by ${e.caller}: ${e.code}`;
    case 'auth':
      return `${e.event}${opt(e.reason)}`;
    default:
      return sessionDetails(e as Parameters<typeof sessionDetails>[0]);
  }
}

const minutes = (ms: number) => Math.round(ms / 60_000);
/** When the hub opened each session (`agent/session` → ms), from its `opened` events. */
type Opened = Map<string, number>;

/**
 * `(clock ±Nm)` only when a reported event's own time is impossible: later than the hub received
 * it (the laptop's clock is ahead), or before the hub opened its session (behind). Otherwise
 * `(sent late, +Nm)` when it reached the hub more than 2 minutes after it happened: it waited in
 * the plugin's buffer, an outage say. Hub events carry neither.
 */
function mark(group: ObservedEvent[], opened: Opened): string {
  const reported = group.filter((e) => e.source !== 'hub');
  for (const e of reported) {
    const at = Date.parse(e.at);
    const ahead = at - Date.parse(e.receivedAt);
    if (ahead > SKEW_MIN_MS) return ` (clock +${minutes(ahead)}m)`;
    const start = opened.get(`${e.agent}/${e.session}`);
    if (start !== undefined && start - at > SKEW_MIN_MS) return ` (clock -${minutes(start - at)}m)`;
  }
  for (const e of reported) {
    const late = Date.parse(e.receivedAt) - Date.parse(e.at);
    if (late > SKEW_MIN_MS) return ` (sent late, +${minutes(late)}m)`;
  }
  return '';
}

function openedSessions(events: ObservedEvent[]): Opened {
  const opened: Opened = new Map();
  for (const e of events) {
    if (e.kind === 'session' && e.phase === 'opened' && e.session)
      opened.set(`${e.agent}/${e.session}`, Date.parse(e.at));
  }
  return opened;
}

const versions = (sorted: ObservedEvent[], agent: string) => {
  const c = sorted.findLast((e) => e.kind === 'connected' && e.agent === agent);
  if (c?.kind !== 'connected') return 'plugin unknown · Claude Code unknown · unknown';
  return `plugin ${c.pluginVersion} · Claude Code ${c.claudeCodeVersion ?? 'unknown'} · ${c.os}`;
};

/** `2026-11-06 10:02–12:03 (UTC+05:30)`; both dates when the range crosses midnight. */
function rangeLabel(events: ObservedEvent[]): string {
  const times = events.map((e) => Date.parse(e.at));
  const first = local(new Date(Math.min(...times)).toISOString());
  const last = local(new Date(Math.max(...times)).toISOString());
  const from = `${first.date} ${first.time.slice(0, 5)}`;
  const lastHm = last.time.slice(0, 5);
  const to = first.date === last.date ? lastHm : `${last.date} ${lastHm}`;
  return `${from}–${to} (${offsetLabel(last.off)})`;
}

function headerLines(sorted: ObservedEvent[], agents: string[], title: string): string[] {
  const range = rangeLabel(sorted);
  if (agents.length === 1) {
    return [`${agents[0]} · ${versions(sorted, agents[0] ?? '')} · ${title} · ${range}`];
  }
  return [
    `${agents.length} agents · ${title} · ${range}`,
    ...agents.map((a) => `  ${a}: ${versions(sorted, a)}`),
  ];
}

export interface TimelineOptions {
  /** What the window was, e.g. `last 2h`. */
  title: string;
  /** More events matched than are shown: the oldest are not. */
  truncated?: boolean;
}

/** About 700 KB: a timeline reply stays well under NATS's 1 MB `max_payload`. */
export const MAX_REPLY_BYTES = 700_000;

/**
 * The `observe.timeline` reply for `events` (oldest first): the newest of them whose events and
 * text fit in `maxBytes` together, and `truncated` when any were left out.
 */
export function fitTimeline(
  events: ObservedEvent[],
  opts: TimelineOptions,
  maxBytes = MAX_REPLY_BYTES,
): { events: ObservedEvent[]; text: string; truncated: boolean } {
  let shown = events;
  let truncated = opts.truncated === true;
  for (;;) {
    const reply = { events: shown, text: formatTimeline(shown, { ...opts, truncated }), truncated };
    const size = Buffer.byteLength(JSON.stringify(reply));
    if (size <= maxBytes || shown.length === 0) return reply;
    // The newest share that should fit, and at least one fewer each round.
    const keep = Math.min(shown.length - 1, Math.floor((shown.length * maxBytes) / size));
    shown = shown.slice(shown.length - keep);
    truncated = true;
  }
}

/** Events grouped per line: a delivery message's events fold together, others stand alone. */
function groupEvents(sorted: ObservedEvent[]): ObservedEvent[][] {
  const groups = new Map<string, ObservedEvent[]>();
  for (const e of sorted) {
    const key = `${e.agent}/${e.kind === 'delivery' ? e.message : e.id}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.values()];
}

/**
 * Plain text, one line per event, in the order they happened by each source's own clock (the
 * hub's receive time breaks ties). Pure: no I/O. Times are in the process zone.
 */
export function formatTimeline(events: ObservedEvent[], opts: TimelineOptions): string {
  if (events.length === 0) return 'no events in this window';
  const sorted = [...events].sort(
    (a, b) =>
      Date.parse(a.at) - Date.parse(b.at) || Date.parse(a.receivedAt) - Date.parse(b.receivedAt),
  );
  const opened = openedSessions(sorted);
  const agents = [...new Set(sorted.map((e) => e.agent))];
  const manySessions = new Set(sorted.map((e) => e.session ?? '-')).size > 1;
  const lines = headerLines(sorted, agents, opts.title);
  if (opts.truncated) {
    lines.push(
      `(truncated: showing the newest ${sorted.length} of more; narrow the window or raise limit)`,
    );
  }
  let day = local(sorted[0]?.at ?? '').date;
  for (const group of groupEvents(sorted)) {
    const e = group[0] as ObservedEvent;
    const text = e.kind === 'delivery' ? journey(group) : details(e);
    const who = agents.length > 1 ? `${e.agent} ` : '';
    const session = manySessions ? `[${group.find((x) => x.session)?.session ?? '-'}] ` : '';
    const when = local(e.at);
    const stamp = when.date === day ? when.time : `${when.date} ${when.time}`;
    day = when.date;
    lines.push(`${stamp}  ${e.kind.padEnd(13)}  ${who}${session}${text}${mark(group, opened)}`);
  }
  return lines.join('\n');
}
