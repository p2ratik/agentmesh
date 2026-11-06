// Built-ins only (the hook and guard bundles import this).
import { PARTICIPANT_ID } from '../pull/state';

/** What a reply pointer names: who answered, in which thread, which message. */
export interface PointerFields {
  from: string;
  threadId: string;
  messageId: string;
}

export const THREAD_ID = /^thr-[1-9]\d{0,11}$/;
export const MESSAGE_ID = /^msg-[0-9A-HJKMNP-TV-Z]{26}$/;

const valid = (re: RegExp, v: unknown): boolean => typeof v === 'string' && re.test(v);

/**
 * The one pointer text the mesh window forwards and the guard checks byte for byte: plain
 * ASCII with no apostrophe, so a retyped quote fails. Null for any field outside its pattern.
 */
export function pointerText({ from, threadId, messageId }: PointerFields): string | null {
  if (
    !valid(PARTICIPANT_ID, from) ||
    !valid(THREAD_ID, threadId) ||
    !valid(MESSAGE_ID, messageId)
  ) {
    return null;
  }
  return `AgentMesh: ${from} answered in ${threadId} (msg ${messageId}). Read it with thread ${threadId} and reply there. Do not reply to this message.`;
}

/** The fields of an exact pointer, or null for any other text. */
export function parsePointer(text: string): PointerFields | null {
  const m = /^AgentMesh: (\S+) answered in (\S+) \(msg (\S+)\)\. /.exec(text);
  if (!m) return null;
  const [, from = '', threadId = '', messageId = ''] = m;
  const fields = { from, threadId, messageId };
  return pointerText(fields) === text ? fields : null;
}
