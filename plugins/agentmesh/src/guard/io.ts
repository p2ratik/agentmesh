// Built-ins only: the worktree guard bundle (dist/guard.js) imports this.
import type { GuardDecision } from './decide';

/** The whole stream as UTF-8, with no size limit: a Write call carries the file's full content.
 * With `capMs`, what has arrived by then (outside the mesh window nothing is decided from it).
 * A stream error rejects. */
export function readAll(stream: NodeJS.ReadableStream, capMs: number | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const done = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = capMs === null ? undefined : setTimeout(done, capMs);
    stream.on('data', (c: Buffer | string) =>
      chunks.push(typeof c === 'string' ? Buffer.from(c) : c),
    );
    stream.on('end', done);
    stream.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** How Claude Code reads a PreToolUse hook: exit 2 blocks with stderr as the reason; an `ask`
 * decision on stdout prompts the human; silence leaves the call to the permission rules. */
export function hookOutput(d: GuardDecision): { exitCode: 0 | 2; stdout: string; stderr: string } {
  if (d.kind === 'deny') return { exitCode: 2, stdout: '', stderr: d.reason };
  if (d.kind === 'ask') {
    const hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: d.reason,
    };
    return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput }), stderr: '' };
  }
  return { exitCode: 0, stdout: '', stderr: '' };
}
