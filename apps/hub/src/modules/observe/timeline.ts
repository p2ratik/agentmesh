import type { ObservedEvent } from '@agentmesh/protocol';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** HH:MM:SS in the zone of `now` (its current UTC offset). */
function clock(iso: string, now: Date): string {
  const d = new Date(new Date(iso).getTime() - now.getTimezoneOffset() * 60_000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

const shortMsg = (id: string) => `msg-…${id.slice(-4)}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const SKEW_MIN_MS = 120_000;

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
  const steps: string[] = [];
  let last = '';
  const step = (key: string, text: string) => {
    if (!stages.has(key)) return false;
    steps.push(text);
    last = key.split(':')[1] ?? key;
    return true;
  };
  const hubFailed = ['failed', 'no_session'].find((s) => stages.has(`hub:${s}`));
  if (hubFailed) {
    steps.push(`hub ${hubFailed}`);
    last = hubFailed;
  } else {
    step('hub:sent', 'hub sent');
  }
  if (step('plugin:received', 'plugin got it')) {
    if (stages.has('plugin:pushed')) {
      return `${head}  ${[...steps, 'pushed to Claude'].join(' → ')} ✓ ${seconds(ms)}`;
    }
    if (stages.has('plugin:push_failed')) {
      steps.push('push failed');
      last = 'push_failed';
    }
  }
  return `${head}  ${steps.join(' → ')} ✗ (${last})`;
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
    case 'delivery':
      return journey([e]);
    default:
      return sessionDetails(e as Parameters<typeof sessionDetails>[0]);
  }
}

/** Skew note for a plugin event whose own clock is far from the hub's receive time. */
function skew(e: ObservedEvent): string {
  if (e.source === 'hub') return '';
  const diff = new Date(e.receivedAt).getTime() - new Date(e.at).getTime();
  if (Math.abs(diff) < SKEW_MIN_MS) return '';
  const min = Math.round(diff / 60_000);
  return ` (clock ${min > 0 ? '+' : ''}${min}m)`;
}

function headerLine(sorted: ObservedEvent[], agents: string[], title: string): string {
  const c = sorted.findLast((e) => e.kind === 'connected');
  const who = agents.length === 1 ? agents[0] : `${agents.length} agents`;
  if (c?.kind !== 'connected')
    return `${who} · plugin unknown · Claude Code unknown · unknown · ${title}`;
  return `${who} · plugin ${c.pluginVersion} · Claude Code ${c.claudeCodeVersion ?? 'unknown'} · ${c.os} · ${title}`;
}

/** Plain text, one line per event, oldest first. Pure: no I/O. */
export function formatTimeline(
  events: ObservedEvent[],
  opts: { title: string; now: Date },
): string {
  const sorted = [...events].sort(
    (a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.at.localeCompare(b.at),
  );
  const agents = [...new Set(sorted.map((e) => e.agent))];
  const header = headerLine(sorted, agents, opts.title);
  const lines = [header];
  // One line per delivery message: the first event of its group carries the journey.
  const groups = new Map<string, ObservedEvent[]>();
  for (const e of sorted) {
    if (e.kind !== 'delivery') continue;
    const key = `${e.agent}/${e.message}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const done = new Set<string>();
  for (const e of sorted) {
    let text: string;
    if (e.kind === 'delivery') {
      const key = `${e.agent}/${e.message}`;
      if (done.has(key)) continue;
      done.add(key);
      text = journey(groups.get(key) ?? [e]);
    } else {
      text = details(e);
    }
    const prefix = agents.length > 1 ? `${e.agent} ` : '';
    lines.push(`${clock(e.at, opts.now)}  ${e.kind.padEnd(13)}  ${prefix}${text}${skew(e)}`);
  }
  return lines.join('\n');
}
