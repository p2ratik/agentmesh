import { redactSecrets } from '@agentmesh/common';
import type { PostIntent } from './intents';

/**
 * Masks secrets in every string inside a value (a feed event). The mesh
 * channels are readable by the whole server, and only mesh messages are
 * redacted by the hub: task titles, plan topics and summaries, notices and
 * external events arrive as written. Keys and non-strings are kept. Pure.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDeep(item)]),
    ) as T;
  }
  return value;
}

/** Masks secrets in all the text one post puts on Discord. Pure. */
export function redactIntent(intent: PostIntent): PostIntent {
  return {
    ...intent,
    content: redactSecrets(intent.content),
    ...(intent.username ? { username: redactSecrets(intent.username) } : {}),
    ...(intent.thread
      ? {
          thread: {
            ...intent.thread,
            title: redactSecrets(intent.thread.title),
            starter: redactSecrets(intent.thread.starter),
          },
        }
      : {}),
  };
}
