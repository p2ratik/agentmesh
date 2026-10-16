/**
 * Renderers turn activity-feed events into these plain descriptions; the
 * executor performs them with discord.js. Keeping intents free of discord.js
 * types keeps every rendering decision a pure, unit-testable function.
 */

/** A Discord thread (or forum post) that mirrors one mesh thread. Created on first use. */
export interface ThreadTarget {
  /** Mesh thread id (`thr-12`); the key of the hub ref that maps it to Discord. */
  threadId: string;
  /** Thread or forum-post name, at most 100 characters. */
  title: string;
  /** Text channels: the line the thread hangs off. Forums: the post's opening message. */
  starter: string;
}

export type ButtonStyleName = 'primary' | 'secondary' | 'success' | 'danger';

export interface IntentButton {
  /** At most 100 characters; parsed back by the button handler. */
  customId: string;
  label: string;
  style: ButtonStyleName;
}

export interface PostIntent {
  /** Channel purpose from config (`council`, `tasks`, `alerts`…); missing ones fall back. */
  purpose: string;
  /** Post inside the Discord thread mirroring this mesh thread. */
  thread?: ThreadTarget;
  /** Post through the channel webhook under this name; omitted means the bot posts. */
  username?: string;
  avatarURL?: string;
  /** Full text; the executor chunks it to Discord's limit. */
  content: string;
  /** Attached to the last chunk. Always posted by the bot (webhooks can't own buttons). */
  buttons?: IntentButton[];
  /** The only users this post may ping; `@everyone`, roles and other users never ping. */
  mentionUserIds?: string[];
}
