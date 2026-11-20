import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existingMesh } from './agent-files';

// A temp home, never the real one; the seed files hold fake text.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cw-agent-files-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const save = (nkeySeed: string) =>
  writeFileSync(
    join(home, '.cosmicwave', 'agent.json'),
    JSON.stringify({ agentId: 'bob-agent', natsUrl: 'tls://hub:4222', nkeySeed }),
  );

describe('existingMesh', () => {
  // The safety net for a crash between the move and agent.json's rewrite.
  it('maps a seed path under ~/.agentmesh into the moved folder once the old file is gone', () => {
    mkdirSync(join(home, '.cosmicwave'));
    writeFileSync(join(home, '.cosmicwave', 'bob-agent.nk'), 'fake');
    save(join(home, '.agentmesh', 'bob-agent.nk'));
    expect(existingMesh(home)?.nkeySeed).toBe(join(home, '.cosmicwave', 'bob-agent.nk'));
  });

  it('passes a seed literal through', () => {
    mkdirSync(join(home, '.cosmicwave'));
    save('SUFAKESEEDNOTAREALONE');
    expect(existingMesh(home)?.nkeySeed).toBe('SUFAKESEEDNOTAREALONE');
  });
});
