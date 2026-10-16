/** Discord's hard limit for a message's `content`. */
export const MESSAGE_LIMIT = 2000;

const FENCE = '```';
/** Room for re-opening (```\n) and closing (\n```) a code block split across chunks. */
const FENCE_RESERVE = 2 * (FENCE.length + 1);
const FENCE_LINE = /^ {0,3}```/gm;

/**
 * Splits text into messages of at most `limit` characters. Splits on line
 * boundaries where possible, then on spaces, then hard-splits very long lines.
 * Code blocks cut in half are closed and re-opened so formatting survives.
 * Returns no chunks for blank text (Discord rejects empty messages).
 */
export function chunkMessage(text: string, limit = MESSAGE_LIMIT): string[] {
  if (text.trim() === '') return [];
  if (text.length <= limit) return [text];
  return balanceFences(splitLines(text, limit - FENCE_RESERVE));
}

function splitLines(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim() !== '') chunks.push(current);
    current = '';
  };
  for (const line of text.split('\n')) {
    for (const piece of splitLongLine(line, limit)) {
      if (current === '') current = piece;
      else if (current.length + 1 + piece.length <= limit) current += `\n${piece}`;
      else {
        flush();
        current = piece;
      }
    }
  }
  flush();
  return chunks;
}

function splitLongLine(line: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    const space = rest.lastIndexOf(' ', limit);
    const atSpace = space >= limit / 2;
    const cut = atSpace ? space : safeCut(rest, limit);
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(atSpace ? cut + 1 : cut);
  }
  pieces.push(rest);
  return pieces;
}

/** Never cuts between the two halves of a surrogate pair (emoji). */
function safeCut(text: string, limit: number): number {
  const code = text.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

function balanceFences(chunks: string[]): string[] {
  let open = false;
  return chunks.map((chunk) => {
    const reopen = open;
    if ((chunk.match(FENCE_LINE)?.length ?? 0) % 2 === 1) open = !open;
    const head = reopen ? `${FENCE}\n${chunk}` : chunk;
    return open ? `${head}\n${FENCE}` : head;
  });
}
