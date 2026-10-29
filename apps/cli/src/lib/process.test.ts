import { describe, expect, it } from 'vitest';
import { runProcess } from './process';

const node = process.execPath;

describe('runProcess', () => {
  it('feeds input to stdin and collects the output and exit code', async () => {
    const echo =
      'process.stdin.pipe(process.stdout); process.stderr.write("warn"); process.exitCode = 3';
    expect(await runProcess(node, ['-e', echo], { input: 'hello' })).toEqual({
      code: 3,
      stdout: 'hello',
      stderr: 'warn',
    });
  });

  it('a missing program is exit 127, not a crash', async () => {
    expect(await runProcess('agentmesh-no-such-program', ['x'])).toEqual({
      code: 127,
      stdout: '',
      stderr: 'agentmesh-no-such-program not found on PATH',
    });
  });
});
