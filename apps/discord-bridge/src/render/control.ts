import type { DomainEventData } from '@agentmesh/protocol';
import { isAtLeast, SEVERITY_EMOJI } from './format';
import type { PostIntent } from './intents';

/** A rule's or the hub's notice, posted to the purpose channel it names. */
export function renderNotice(data: DomainEventData<'notice.posted'>): PostIntent[] {
  const prefix = isAtLeast(data.severity, 'warning') ? `${SEVERITY_EMOJI[data.severity]} ` : '';
  return [{ purpose: data.channel, content: `${prefix}${data.text}` }];
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
