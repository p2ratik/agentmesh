import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

  it('refuses a value that would add a line, naming the key but never the value', () => {
    for (const value of ['tok-secret\nNATS_BIND=0.0.0.0', 'tok-secret\r']) {
      let message = '';
      try {
        setEnvValues(ENV, { DISCORD_BOT_TOKEN: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('DISCORD_BOT_TOKEN');
      expect(message).not.toContain('tok-secret');
      expect(message).not.toContain('NATS_BIND');
    }
  });
});

describe('env files', () => {
  /** A `.env` that others may read, so the update has to tighten it. */
  const envFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-env-'));
    const path = join(dir, '.env');
    writeFileSync(path, ENV, { mode: 0o644 });
    return { dir, path };
  };

  it('update then read', () => {
    const { path } = envFile();
    updateEnvFile(path, { DISCORD_GUILD_ID: '7' });
    expect(readEnvFile(path).get('DISCORD_GUILD_ID')).toBe('7');
    expect(readFileSync(path, 'utf8')).toBe(`${ENV}DISCORD_GUILD_ID=7\n`);
  });

  it('replaces the file in one rename and leaves no temp file behind', () => {
    const { dir, path } = envFile();
    const before = statSync(path, { bigint: true }).ino;
    updateEnvFile(path, { DISCORD_GUILD_ID: '7' });
    expect(statSync(path, { bigint: true }).ino).not.toBe(before);
    expect(readdirSync(dir)).toEqual(['.env']);
  });

  it.skipIf(process.platform === 'win32')('stays readable only by its owner', () => {
    const { path } = envFile();
    updateEnvFile(path, { DISCORD_GUILD_ID: '7' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
