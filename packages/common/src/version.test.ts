import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION } from './version';

describe('VERSION', () => {
  it('every package.json, the plugin manifest and VERSION agree', () => {
    const root = join(import.meta.dirname, '../../..');
    const files = [
      ...[
        'apps/hub',
        'apps/discord-bridge',
        'apps/cli',
        'packages/bus',
        'packages/common',
        'packages/config',
        'packages/protocol',
        'plugins/agentmesh',
        'tests',
      ].map((d) => `${d}/package.json`),
      'plugins/agentmesh/.claude-plugin/plugin.json',
    ];
    for (const f of files) {
      expect(JSON.parse(readFileSync(join(root, f), 'utf8')).version, f).toBe(VERSION);
    }
  });
});
