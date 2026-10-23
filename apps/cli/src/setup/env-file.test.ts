import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv, readEnvFile, setEnvValues, updateEnvFile } from './env-file';

const ENV = '# The token\nDISCORD_BOT_TOKEN=\n# The app\nDISCORD_APP_ID=\nNATS_BIND=127.0.0.1\n';

describe('parseEnv', () => {
  it('strips surrounding quotes and whitespace', () => {
    const env = parseEnv('DISCORD_BOT_TOKEN="abc" \nB=\'x\'\n  C = y  \r\nD=\n');
    expect(env.get('DISCORD_BOT_TOKEN')).toBe('abc');
    expect(env.get('B')).toBe('x');
    expect(env.get('C')).toBe('y');
    expect(env.get('D')).toBe('');
  });

  it('ignores comments', () => {
    const env = parseEnv('# A=1\n  # B=2\nC=3 # three\nD="4 # four"\n');
    expect([...env]).toEqual([
      ['C', '3'],
      ['D', '4 # four'],
    ]);
  });
});

describe('setEnvValues', () => {
  it('replaces in place, keeps comments and order, appends unknown keys', () => {
    const text = setEnvValues(ENV, { DISCORD_APP_ID: '42', EXTRA: 'e' });
    expect(text).toBe(
      '# The token\nDISCORD_BOT_TOKEN=\n# The app\nDISCORD_APP_ID=42\nNATS_BIND=127.0.0.1\nEXTRA=e\n',
    );
  });

  it('keeps CRLF line endings', () => {
    expect(setEnvValues('A=1\r\nB=2\r\n', { A: '3' })).toBe('A=3\r\nB=2\r\n');
  });

  it('refuses a value that would add a line', () => {
    expect(() => setEnvValues(ENV, { DISCORD_APP_ID: '1\nNATS_BIND=0.0.0.0' })).toThrow(
      'DISCORD_APP_ID',
    );
  });
});

describe('env files', () => {
  it('update then read', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentmesh-env-')), '.env');
    writeFileSync(path, ENV);
    updateEnvFile(path, { DISCORD_GUILD_ID: '7' });
    expect(readEnvFile(path).get('DISCORD_GUILD_ID')).toBe('7');
    expect(readFileSync(path, 'utf8')).toBe(`${ENV}DISCORD_GUILD_ID=7\n`);
  });
});
