import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

// Off-site backups (docs/deploy.md#off-site-backups), run for real against a local bare repository
// standing in for the backup repository. docker, age and `date -u +%F` are stubs.
const SCRIPT = 'deploy/backup/agentmesh-backup.sh';
const SCRIPTS = [SCRIPT, 'deploy/backup/install.sh'];
const RECIPIENT = `age1${'q'.repeat(58)}`;
const hasBash =
  spawnSync('bash', ['-c', '[ "$PROBE" = 1 ]'], { env: { ...process.env, PROBE: '1' } }).status ===
    0 && spawnSync('git', ['--version']).status === 0;

const STUBS = {
  // `docker compose exec -T hub node …`: the snapshot is the day's name, or a failure.
  docker:
    '[ -z "$STUB_SNAPSHOT_FAIL" ] || { echo boom >&2; exit 1; }\nprintf "SQLITE-%s" "$STUB_DAY"',
  // `age -r <recipient>`: a readable header, then the plaintext, so the test can open it.
  age: '[ "$1" = -r ] || exit 9\nprintf "AGE(%s)\\n" "$2"\ncat',
  date: 'if [ "$*" = "-u +%F" ]; then echo "$STUB_DAY"; else exec /usr/bin/date "$@"; fi',
};

let dir: string;
let remote: string;
const slash = (p: string) => p.replaceAll('\\', '/');

function git(...args: string[]) {
  const r = spawnSync('git', ['--git-dir', remote, ...args]);
  return { status: r.status, out: r.stdout.toString().trim(), raw: r.stdout as Buffer };
}

function run(env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, 'run'], {
    encoding: 'utf8',
    env: {
      PATH: `${slash(join(dir, 'bin'))}:${process.env.PATH}`,
      HOME: slash(dir),
      AGENTMESH_DIR: slash(join(dir, 'checkout')),
      BACKUP_REMOTE: remote,
      AGE_RECIPIENT: RECIPIENT,
      STATE_DIRECTORY: slash(join(dir, 'state')),
      RUNTIME_DIRECTORY: slash(join(dir, 'run')),
      STUB_DAY: '2026-11-13',
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The tar.gz inside an encrypted copy, after the stub's header. */
function opened(ref: string) {
  const blob = git('show', `${ref}:hub-backup.tar.gz.age`).raw;
  const header = blob.subarray(0, blob.indexOf(10)).toString();
  const tgz = blob.subarray(blob.indexOf(10) + 1);
  const list = spawnSync('tar', ['-tzf', '-'], { input: tgz }).stdout.toString();
  const db = spawnSync('tar', ['-xzOf', '-', 'hub.sqlite'], { input: tgz }).stdout.toString();
  return { header, entries: list.split('\n').filter(Boolean), db };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-backup-'));
  remote = slash(join(dir, 'remote.git'));
  spawnSync('git', ['init', '--quiet', '--bare', remote]);
  const files: Record<string, string> = {
    'checkout/deploy/docker-compose.yml': 'services: {}\n',
    'checkout/config/mesh.yaml': 'mesh: {}\n',
    'checkout/deploy/.env': 'DISCORD_BOT_TOKEN=x\n',
    'checkout/deploy/secrets/hub.nk': 'SUAX\n',
    'checkout/deploy/nats/nats.conf': 'port: 4222\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'run'));
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(dir, 'bin', name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
});

describe.skipIf(!hasBash)('agentmesh-backup run', () => {
  it('pushes an encrypted daily and hourly copy of the database and the files', () => {
    const r = run();
    expect(r.stderr).toContain('no deploy/docker-compose.override.yml');
    expect(r.status).toBe(0);
    expect(git('log', '--format=%s', 'main').out).toBe('daily 2026-11-13');
    expect(git('rev-list', '--count', 'hourly').out).toBe('1');
    const copy = opened('hourly');
    expect(copy.header).toBe(`AGE(${RECIPIENT})`);
    expect(copy.db).toBe('SQLITE-2026-11-13');
    for (const entry of [
      'hub.sqlite',
      'config/mesh.yaml',
      'deploy/.env',
      'deploy/secrets/hub.nk',
    ]) {
      expect(copy.entries).toContain(entry);
    }
    expect(copy.entries).toContain('deploy/nats/nats.conf');
    // No plaintext outlives the run.
    expect(readdirSync(join(dir, 'run'))).toEqual([]);
    expect(readFileSync(join(dir, 'state', 'last-daily'), 'utf8').trim()).toBe('2026-11-13');
  }, 60_000);

  it('replaces the hourly copy on later runs and adds one daily commit per day', () => {
    expect(run().status).toBe(0);
    const first = git('rev-parse', 'hourly').out;
    expect(run().status).toBe(0);
    expect(git('rev-list', '--count', 'hourly').out).toBe('1');
    expect(git('rev-parse', 'hourly').out).not.toBe(first);
    expect(git('log', '--format=%s', 'main').out).toBe('daily 2026-11-13');

    expect(run({ STUB_DAY: '2026-11-14' }).status).toBe(0);
    expect(git('log', '--format=%s', 'main').out.split('\n')).toEqual([
      'daily 2026-11-14',
      'daily 2026-11-13',
    ]);
    expect(opened('main').db).toBe('SQLITE-2026-11-14');
    expect(opened('main~1').db).toBe('SQLITE-2026-11-13');
  }, 60_000);

  it('pushes nothing when the snapshot fails', () => {
    const r = run({ STUB_SNAPSHOT_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('nothing was pushed');
    expect(git('for-each-ref').out).toBe('');
    expect(readdirSync(join(dir, 'run'))).toEqual([]);
  }, 60_000);

  it.each([
    [{ BACKUP_REMOTE: '' }, 'set BACKUP_REMOTE'],
    [{ AGE_RECIPIENT: 'ssh-ed25519 AAAA' }, 'set AGE_RECIPIENT'],
  ])('refuses to run with %j', (env, message) => {
    const r = run(env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(git('for-each-ref').out).toBe('');
  });

  it.each(SCRIPTS)('%s parses', (file) => {
    const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('backup scripts', () => {
  // Bash reads an apostrophe in "${VAR:?message}" as a quote (see agentmesh-deploy.test.ts).
  it.each(SCRIPTS)('%s keeps apostrophes out of variable expansions', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text.match(/\$\{\w+:?[?=+-][^}]*'[^}]*\}/g) ?? []).toEqual([]);
  });
});
