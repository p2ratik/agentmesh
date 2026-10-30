import { describe, expect, it } from 'vitest';
import { FALLBACK_SOURCE, marketplaceSource, setAutoUpdate } from './claude-settings';

/** known_marketplaces.json as Claude Code writes it (seen on a real Windows install). */
const KNOWN = JSON.stringify({
  agentmesh: {
    source: { source: 'github', repo: 'acme/agentmesh-fork' },
    installLocation: 'C:\\Users\\dana\\.claude\\plugins\\marketplaces\\agentmesh',
    lastUpdated: '2026-10-24T12:48:25.575Z',
  },
});
const SOURCE = { source: 'github', repo: 'p2ratik/agentmesh' };
const parsed = (r: { text: string }) => JSON.parse(r.text);

describe('marketplaceSource', () => {
  it('copies only the source Claude Code recorded for the marketplace', () => {
    expect(marketplaceSource(KNOWN, 'agentmesh')).toEqual({
      source: 'github',
      repo: 'acme/agentmesh-fork',
    });
  });

  it('falls back to the GitHub repo when the record is missing, unreadable or odd', () => {
    expect(FALLBACK_SOURCE).toEqual(SOURCE);
    for (const known of [undefined, 'not json', '[]', 'null', '{"agentmesh": {"source": "x"}}']) {
      expect(marketplaceSource(known, 'agentmesh')).toEqual(SOURCE);
    }
  });

  it('refuses to guess the source of another marketplace', () => {
    expect(() => marketplaceSource(KNOWN, 'other')).toThrow(/no marketplace named "other"/);
    expect(() => marketplaceSource(KNOWN, '__proto__')).toThrow(/no marketplace/);
  });
});

describe('setAutoUpdate', () => {
  it('starts a missing file from {}', () => {
    const r = setAutoUpdate(undefined, 'agentmesh', SOURCE, true);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(
      `${JSON.stringify({ extraKnownMarketplaces: { agentmesh: { source: SOURCE, autoUpdate: true } } }, null, 2)}\n`,
    );
  });

  it('leaves every other key and marketplace untouched', () => {
    const settings = {
      env: { API_TOKEN: 'secret' },
      permissions: { allow: ['mcp__plugin_agentmesh_mesh__*'] },
      extraKnownMarketplaces: { other: { source: { source: 'git', url: 'https://x' } } },
    };
    const r = setAutoUpdate(JSON.stringify(settings), 'agentmesh', SOURCE, true);
    expect(parsed(r)).toEqual({
      ...settings,
      extraKnownMarketplaces: {
        ...settings.extraKnownMarketplaces,
        agentmesh: { source: SOURCE, autoUpdate: true },
      },
    });
  });

  it('keeps an existing entry’s other fields and replaces its source', () => {
    const before = {
      extraKnownMarketplaces: {
        agentmesh: { source: { source: 'github', repo: 'old/repo' }, note: 'keep' },
      },
    };
    const r = setAutoUpdate(JSON.stringify(before), 'agentmesh', SOURCE, true);
    expect(parsed(r).extraKnownMarketplaces.agentmesh).toEqual({
      source: SOURCE,
      note: 'keep',
      autoUpdate: true,
    });
  });

  it('turns it off, and reports no change when the entry already says so', () => {
    const on = setAutoUpdate('{}', 'agentmesh', SOURCE, true);
    const off = setAutoUpdate(on.text, 'agentmesh', SOURCE, false);
    expect(off.changed).toBe(true);
    expect(parsed(off).extraKnownMarketplaces.agentmesh.autoUpdate).toBe(false);
    expect(setAutoUpdate(off.text, 'agentmesh', SOURCE, false).changed).toBe(false);
    expect(setAutoUpdate(on.text, 'agentmesh', SOURCE, true).changed).toBe(false);
  });

  it('reads a file with a byte order mark', () => {
    expect(setAutoUpdate('\uFEFF{"model": "x"}', 'agentmesh', SOURCE, true).changed).toBe(true);
  });

  it('refuses text that is not a settings object, without quoting it', () => {
    const bad = [
      '{"env": {"TOKEN": "tok-SECRET-1"',
      '["tok-SECRET-1"]',
      'null',
      '{"extraKnownMarketplaces": ["tok-SECRET-1"]}',
      '{"extraKnownMarketplaces": {"agentmesh": "tok-SECRET-1"}}',
    ];
    for (const text of bad) {
      expect(() => setAutoUpdate(text, 'agentmesh', SOURCE, true)).toThrow(/Nothing was changed/);
      try {
        setAutoUpdate(text, 'agentmesh', SOURCE, true);
      } catch (error) {
        expect((error as Error).message).not.toContain('SECRET');
      }
    }
  });
});
