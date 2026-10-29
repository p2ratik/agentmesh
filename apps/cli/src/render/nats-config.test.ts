import type { NatsUser } from '@agentmesh/bus/permissions';
import { describe, expect, it } from 'vitest';
import { type NatsConfigInput, renderNatsConfig } from './nats-config';

const key = (letter: string, n: number) => `${letter}${String(n).repeat(55)}`;

const users: NatsUser[] = [
  { id: 'hub', kind: 'hub', nkey: key('U', 1) },
  { id: 'discord-bridge', kind: 'bridge', nkey: key('U', 2) },
  { id: 'alice-agent', kind: 'agent', nkey: key('U', 3) },
];

const render = (extra: Partial<NatsConfigInput> = {}) =>
  renderNatsConfig({
    meshName: 'acme',
    prefix: 'mesh',
    users,
    dev: false,
    maxFileStore: '5GB',
    allowMissing: false,
    ...extra,
  }).text;

const callout = { authCallout: { issuer: key('A', 4), xkey: key('X', 5), sysNkey: key('U', 6) } };

describe('renderNatsConfig limits', () => {
  it.each([
    ['static', {}],
    ['auth-callout', callout],
    ['dev', { dev: true }],
  ])('caps connections, subscriptions and payload in %s mode', (_mode, extra) => {
    const lines = render(extra).split('\n');
    expect(lines).toContain('max_connections: 1024');
    expect(lines).toContain('max_subscriptions: 1000');
    expect(lines).toContain('max_payload: 1MB');
  });

  it.each([
    ['static', {}],
    ['auth-callout', callout],
  ])('pins JetStream strict mode inside the jetstream block in %s mode', (_mode, extra) => {
    const text = render(extra);
    const block = text.slice(
      text.indexOf('jetstream {'),
      text.indexOf('}', text.indexOf('jetstream {')),
    );
    expect(block).toContain('  max_file_store: 5GB');
    expect(block).toContain('  strict: true');
  });

  it('takes another connection cap and refuses one that is not a whole number', () => {
    expect(render({ maxConnections: 4096 }).split('\n')).toContain('max_connections: 4096');
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => render({ maxConnections: bad })).toThrow(/--max-connections/);
    }
  });
});
