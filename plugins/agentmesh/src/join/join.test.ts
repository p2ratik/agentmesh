import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeInvite, type InvitePayload } from '@agentmesh/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config';
import { meshToolHandler } from '../tools/registry';
import { saveEnrollment } from './files';
import { runJoin } from './flow';
import { readInvite } from './invite';
import { callJoinTool } from './tool';

const SEED = `SU${'A'.repeat(56)}`;
const enrollMock = vi.hoisted(() => vi.fn());
vi.mock('./enroll', () => ({ enroll: enrollMock }));

const payload: InvitePayload = {
  v: 1,
  natsUrl: 'tls://mesh.example.com:4222',
  inviteId: 'inv-abc123',
  agentId: 'dana-agent',
  prefix: 'acme',
  secret: `${'B'.repeat(42)}Q`,
};
const CODE = encodeInvite(payload);

function home(): string {
  return mkdtempSync(join(tmpdir(), 'agentmesh-join-'));
}

function inviteFile(dir: string, code = CODE): string {
  const file = join(dir, 'invite.txt');
  writeFileSync(file, `${code}\n`);
  return file;
}

beforeEach(() => {
  enrollMock.mockReset();
  enrollMock.mockResolvedValue({ self: { id: 'dana-agent' }, mesh: { name: 'acme' } });
});

describe('invites', () => {
  it('shows where an invite points without echoing it', () => {
    expect(readInvite(CODE).hub).toBe('mesh.example.com:4222');
    const bad = `${CODE.slice(0, -4)}????`;
    expect(() => readInvite(bad)).toThrow('Not a valid AgentMesh invite code');
    try {
      readInvite(bad);
    } catch (error) {
      expect(String(error)).not.toContain(bad);
    }
  });

  it('refuses websocket invites, which the plugin cannot dial', () => {
    const wss = encodeInvite({ ...payload, natsUrl: 'wss://mesh.example.com' });
    expect(() => readInvite(wss)).toThrow(/websocket/);
  });
});

describe('runJoin', () => {
  it('connects nothing until the human confirms that exact hub', async () => {
    const dir = home();
    const request = { code: CODE, home: dir, clientVersion: 't', replace: false };
    expect((await runJoin(request)).kind).toBe('confirm');
    expect((await runJoin({ ...request, confirmedHub: 'evil.example.com:4222' })).kind).toBe(
      'confirm',
    );
    expect(enrollMock).not.toHaveBeenCalled();
    expect((await runJoin({ ...request, confirmedHub: 'mesh.example.com:4222' })).kind).toBe(
      'joined',
    );
    expect(enrollMock).toHaveBeenCalledOnce();
  });

  it('refuses to replace another mesh unless asked to', async () => {
    const dir = home();
    saveEnrollment(dir, { ...payload, agentId: 'old-agent' }, SEED);
    const request = { code: CODE, home: dir, clientVersion: 't', replace: false };
    await expect(runJoin(request)).rejects.toThrow(/already set up as old-agent/);
    expect((await runJoin({ ...request, replace: true })).kind).toBe('confirm');
  });
});

describe('saving the key', () => {
  it('has the seed on disk before connecting, and removes it if the hub refuses', async () => {
    const dir = home();
    const seedDir = join(dir, '.agentmesh');
    enrollMock.mockImplementationOnce(async (_summary, _code, seed: string) => {
      expect(readFileSync(join(seedDir, 'dana-agent.nk.joining'), 'utf8')).toBe(`${seed}
`);
      throw new Error('refused');
    });
    const request = { code: CODE, home: dir, clientVersion: 't', replace: false };
    await expect(runJoin({ ...request, confirmedHub: 'mesh.example.com:4222' })).rejects.toThrow(
      'refused',
    );
    expect(readdirSync(seedDir)).toEqual([]);
  });

  it('still saves everything when the hub admitted us but did not say hello in time', async () => {
    const dir = home();
    enrollMock.mockResolvedValueOnce(null);
    const request = { code: CODE, home: dir, clientVersion: 't', replace: false };
    const done = await runJoin({ ...request, confirmedHub: 'mesh.example.com:4222' });
    expect(done.kind === 'joined' && existsSync(done.saved.configFile)).toBe(true);
    expect(readdirSync(join(dir, '.agentmesh')).sort()).toEqual(['agent.json', 'dana-agent.nk']);
  });
});

describe('saveEnrollment', () => {
  it('writes a private seed file and an agent.json the plugin loads', () => {
    const dir = home();
    const saved = saveEnrollment(dir, payload, SEED);
    expect(readFileSync(saved.seedFile, 'utf8')).toBe(`${SEED}\n`);
    const config = JSON.parse(readFileSync(saved.configFile, 'utf8'));
    expect(config).toEqual({
      agentId: 'dana-agent',
      natsUrl: 'tls://mesh.example.com:4222',
      nkeySeed: saved.seedFile,
      prefix: 'acme',
    });
    expect(JSON.stringify(config)).not.toContain(SEED);
    if (process.platform !== 'win32') {
      expect(statSync(saved.seedFile).mode & 0o777).toBe(0o600);
      expect(statSync(saved.configFile).mode & 0o777).toBe(0o600);
    }
    const loaded = resolveConfig({}, saved.configFile);
    expect(loaded.ok && loaded.config).toMatchObject({
      agentId: 'dana-agent',
      servers: ['tls://mesh.example.com:4222'],
      prefix: 'acme',
    });
  });
});

describe('join tool', () => {
  it('asks for confirmation, then joins, deletes the invite and never shows secrets', async () => {
    const dir = home();
    const file = inviteFile(dir);
    const onJoined = vi.fn(async () => undefined);
    const deps = { clientVersion: 't', home: dir, onJoined };

    const first = await callJoinTool({ invite_file: file }, deps);
    expect(first.isError).toBeUndefined();
    expect(first.content[0]?.text).toContain('confirm_hub: "mesh.example.com:4222"');

    const second = await callJoinTool(
      { invite_file: file, confirm_hub: 'mesh.example.com:4222' },
      deps,
    );
    const text = `${first.content[0]?.text}${second.content[0]?.text}`;
    expect(second.content[0]?.text).toContain('Joined the AgentMesh "acme" as dana-agent');
    expect(text).not.toContain(SEED);
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(payload.secret);
    expect(existsSync(file)).toBe(false);
    expect(onJoined).toHaveBeenCalledWith('dana-agent');
  });

  it('explains a missing invite file without touching the network', async () => {
    const dir = home();
    const result = await callJoinTool({}, { clientVersion: 't', home: dir, onJoined: vi.fn() });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(join(dir, '.agentmesh', 'invite.txt'));
    expect(enrollMock).not.toHaveBeenCalled();
  });
});

describe('unenrolled plugin', () => {
  it('is detected when neither agent_id nor nats_url is set anywhere', () => {
    const missing = join(home(), 'agent.json');
    const none = resolveConfig({}, missing);
    expect(!none.ok && none.unenrolled).toBe(true);
    const half = resolveConfig({ AGENTMESH_AGENT_ID: 'dana-agent' }, missing);
    expect(!half.ok && half.unenrolled).toBe(false);
  });

  it('lists every mesh tool once joined', () => {
    expect(meshToolHandler({ problems: [] }).list().length).toBeGreaterThan(10);
  });
});
