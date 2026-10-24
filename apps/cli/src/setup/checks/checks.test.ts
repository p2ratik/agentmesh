import { createServer, type Server, type Socket } from 'node:net';
import { DiscordConfig } from '@agentmesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import { renderChecklist } from '../render/checklist';
import { classifyContainers } from './containers';
import { classifyChannels } from './discord';
import { checkNatsTls, classifyCert, connectionError } from './nats-tls';

const NOW = new Date('2026-10-24T12:00:00Z');
const HOST = 'mesh.acme.dev';

describe('classifyCert', () => {
  it('a certificate with 60 days left passes, with its date', () => {
    expect(
      classifyCert({ authorized: true, validTo: 'Dec 23 12:00:00 2026 GMT' }, HOST, NOW),
    ).toEqual({ ok: true, label: 'mesh.acme.dev:4222 answers TLS (cert valid to 23 Dec 2026)' });
  });

  it('one with 5 days left fails: its renewal is failing', () => {
    const result = classifyCert(
      { authorized: true, validTo: 'Oct 29 12:00:00 2026 GMT' },
      HOST,
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.label).toContain('29 Oct 2026');
    expect(result.detail).toContain('renewal is failing');
  });

  it('an untrusted certificate fails with the reason', () => {
    const result = classifyCert(
      {
        authorized: false,
        authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID',
        validTo: 'Dec 23 12:00:00 2026 GMT',
      },
      HOST,
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ERR_TLS_CERT_ALTNAME_INVALID');
  });
});

describe('checkNatsTls', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
  });

  /** A local server that runs `greet` on each connection; resolves with its port. */
  function serve(greet: (socket: Socket) => void): Promise<number> {
    server = createServer(greet);
    return new Promise((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
  }

  it('a NATS server without TLS fails', async () => {
    const port = await serve((socket) => socket.write('INFO {"tls_required":false}\r\n'));
    const result = await checkNatsTls('127.0.0.1', port, NOW);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('NATS does not offer TLS');
  });

  it('a server that never answers times out', async () => {
    const port = await serve(() => {});
    const result = await checkNatsTls('127.0.0.1', port, NOW, 50);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('No answer');
  });
});

describe('connectionError', () => {
  it("names the reason when every address refused (an AggregateError's empty message)", () => {
    const refused = (address: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED' });
    const both = new AggregateError([refused('::1:4222'), refused('127.0.0.1:4222')], '');
    expect(connectionError(Object.assign(both, { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
    expect(connectionError(new AggregateError([refused('::1:4222')], ''))).toBe(
      'connect ECONNREFUSED ::1:4222',
    );
    expect(connectionError(refused('127.0.0.1:4222'))).toBe('connect ECONNREFUSED 127.0.0.1:4222');
  });
});

/** One `docker compose ps --format json` line, with some of the fields compose prints. */
const ps = (Service: string, State: string, Health = '') =>
  JSON.stringify({ Name: `agentmesh-${Service}-1`, Service, State, Health, ExitCode: 0 });

describe('classifyContainers', () => {
  it('all three running and the hub healthy pass', () => {
    const lines = [
      ps('nats', 'running'),
      ps('hub', 'running', 'healthy'),
      ps('discord-bridge', 'running'),
    ];
    expect(classifyContainers(`${lines.join('\n')}\n`)).toEqual([
      { ok: true, label: 'nats, hub (healthy) and discord-bridge are running' },
    ]);
  });

  it('a hub still starting fails and points at its logs', () => {
    const lines = [
      ps('nats', 'running'),
      ps('hub', 'running', 'starting'),
      ps('discord-bridge', 'running'),
    ];
    const results = classifyContainers(lines.join('\n'));
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.label).toBe('hub is starting');
    expect(results[0]?.detail).toContain('docker compose logs hub');
  });

  it('a missing bridge fails', () => {
    const results = classifyContainers(
      [ps('nats', 'running'), ps('hub', 'running', 'healthy')].join('\n'),
    );
    expect(results).toEqual([
      expect.objectContaining({ ok: false, label: 'discord-bridge is not running' }),
    ]);
  });

  it('output it cannot read fails', () => {
    expect(classifyContainers('not json')[0]?.ok).toBe(false);
  });
});

describe('classifyChannels', () => {
  const discord = DiscordConfig.parse({});
  const all = [
    { name: 'Agent Mesh', type: 4, parent_id: null },
    ...Object.values(discord.channels).map((c) => ({
      name: c.name,
      type: c.type === 'forum' ? 15 : 0,
      parent_id: '300000000000000003',
    })),
  ];

  it('the category and every channel pass', () => {
    expect(classifyChannels(all, discord.provision.category, discord.channels)).toEqual({
      ok: true,
      label: 'Discord: category, 7 channels and the planning forum exist',
    });
  });

  it('a missing channel is named', () => {
    const result = classifyChannels(
      all.filter((c) => c.name !== 'mesh-alerts'),
      discord.provision.category,
      discord.channels,
    );
    expect(result.ok).toBe(false);
    expect(result.label).toContain('#mesh-alerts');
    expect(result.label).not.toContain('mesh-council');
  });

  it('a planning channel that is not a forum is missing', () => {
    const textPlanning = all.map((c) => (c.name === 'mesh-planning' ? { ...c, type: 0 } : c));
    const result = classifyChannels(textPlanning, discord.provision.category, discord.channels);
    expect(result.ok).toBe(false);
    expect(result.label).toContain('#mesh-planning');
  });
});

describe('renderChecklist', () => {
  it('all passing', () => {
    expect(renderChecklist('Acme', [{ ok: true, label: 'one' }])).toBe(
      'AgentMesh is live for Acme\n ✓ one',
    );
  });

  it('a failure shows what to do next', () => {
    const text = renderChecklist('Acme', [
      { ok: true, label: 'one' },
      { ok: false, label: 'two', detail: 'fix two\nthen run again' },
      { ok: false, label: 'three' },
    ]);
    expect(text).toBe(
      [
        'AgentMesh for Acme: 2 problems',
        ' ✓ one',
        ' ✗ two',
        '   → fix two',
        '     then run again',
        ' ✗ three',
      ].join('\n'),
    );
  });
});
