import type { DomainEventData } from '@agentmesh/protocol';
import { isAtLeast, link, oneLine, SEVERITY_EMOJI } from './format';
import type { PostIntent } from './intents';

/**
 * One alerts line per external event (CI, monitoring, error tracking). Events
 * no rule cared about are shown only from `warning` up, to keep alerts quiet.
 */
export function renderExternalReceived(data: DomainEventData<'external.received'>): PostIntent[] {
  const { event, matchedRules } = data;
  if (matchedRules.length === 0 && !isAtLeast(event.severity, 'warning')) return [];
  const parts = [
    `${SEVERITY_EMOJI[event.severity]} **${event.severity}** · ${event.source}/${event.type}`,
    event.summary ? oneLine(event.summary, 500) : '',
    event.url ? link(event.url) : '',
    matchedRules.length > 0 ? `rules: ${matchedRules.join(', ')}` : '',
  ];
  return [{ purpose: 'alerts', content: parts.filter(Boolean).join(' · ') }];
}
