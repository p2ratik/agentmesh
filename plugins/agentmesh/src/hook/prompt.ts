// Built-ins only (the hook bundle imports this).
import { type LocalSession, replyNote } from '../relay/local-session';
import { parsePointer } from '../relay/pointer';

const TURN =
  /^<cross-session-message from="([^"]*)"[^>]*>\n([\s\S]*)\n<\/cross-session-message>\s*$/;

/** A prompt that is one message from another local session: its sender address and body. */
export function crossSessionTurn(prompt: unknown): { from: string; body: string } | null {
  if (typeof prompt !== 'string') return null;
  const m = TURN.exec(prompt.trimStart());
  return m ? { from: m[1] ?? '', body: m[2] ?? '' } : null;
}

export const VERIFIED = (t: string): string =>
  `AgentMesh: a verified reply pointer from your mesh window. Read ${t} with the thread tool and reply there if it needs an answer; never reply to this message.`;

export const NOT_MESH =
  'AgentMesh: this cross-session message is not from your mesh window, so it is not AgentMesh.';

export interface PromptInput {
  prompt: unknown;
  /** This session is the marked mesh window. */
  marked: boolean;
  /** This session's own fresh private record (matched by CLAUDE_PID), if it used the mesh. */
  own: LocalSession | null;
  /** The addresses this agent's fresh mesh windows publish in their heartbeats. */
  windowAddresses: readonly string[];
}

/**
 * The line a private session's prompt gets. A cross-session turn is a verified pointer only
 * when the sender is this agent's mesh window (never by `from-name`) and the body is exactly a
 * pointer; anything else is labelled not AgentMesh, and never gets the note.
 */
export function promptContext({
  prompt,
  marked,
  own,
  windowAddresses,
}: PromptInput): string | null {
  if (marked) return null; // Task 7 adds the window's label.
  const turn = crossSessionTurn(prompt);
  if (!turn) return own ? replyNote(own) : null;
  if (!own) return null;
  const pointer = windowAddresses.includes(turn.from) ? parsePointer(turn.body) : null;
  return pointer ? VERIFIED(pointer.threadId) : NOT_MESH;
}
