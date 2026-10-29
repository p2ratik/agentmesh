import type { DomainEventData } from '@agentmesh/protocol';
import { EXTERNAL, isAtLeast, SEVERITY_EMOJI } from './format';
import type { PostIntent } from './intents';

/** Leaves room for the badge, marker and fence under Discord's 2000: a notice is one message. */
export const NOTICE_TEXT_LIMIT = 1800;
const FENCE = '```';

/**
 * A rule's or the hub's notice, posted to the purpose channel it names, cut to
 * one Discord message (a 65k issue body would otherwise stall the feed). External text is marked
 * and fenced as code, so its markdown (headings, masked links) cannot pass for the mesh's own;
 * a zero-width space after each backtick keeps it from closing the fence.
 */
export function renderNotice(data: DomainEventData<'notice.posted'>): PostIntent[] {
  const prefix = isAtLeast(data.severity, 'warning') ? `${SEVERITY_EMOJI[data.severity]} ` : '';
  const content =
    data.trust === 'external'
      ? `${prefix}${EXTERNAL}\n${FENCE}\n${cut(data.text.replaceAll('`', '`\u200b'))}\n${FENCE}`
      : `${prefix}${cut(data.text)}`;
  return [{ purpose: data.channel, content }];
}

function cut(text: string): string {
  return text.length <= NOTICE_TEXT_LIMIT
    ? text
    : `${text.slice(0, NOTICE_TEXT_LIMIT)}… (truncated)`;
}

/** The kill switch is announced in events and, so humans notice, in escalations. */
export function renderPaused(data: DomainEventData<'mesh.paused'>): PostIntent[] {
  const reason = data.reason ? `: ${data.reason}` : '';
  const content = `⏸️ **Mesh paused** by ${data.by}${reason}. Deliveries are held until \`/mesh resume\`.`;
  return [
    { purpose: 'events', content },
    { purpose: 'escalations', content },
  ];
}

export function renderResumed(data: DomainEventData<'mesh.resumed'>): PostIntent[] {
  const held = data.released === 1 ? '1 held delivery' : `${data.released} held deliveries`;
  return [{ purpose: 'events', content: `▶️ **Mesh resumed** by ${data.by}; released ${held}.` }];
}
