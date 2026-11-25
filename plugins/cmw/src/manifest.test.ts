import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Option {
  type: string;
  title: string;
  description: string;
  sensitive?: boolean;
  required?: boolean;
}
interface Manifest {
  userConfig?: Record<string, Option>;
  mcpServers: Record<string, { env: Record<string, string> }>;
  channels: Array<{ server: string; displayName: string; userConfig?: unknown }>;
}
const manifest: Manifest = JSON.parse(
  readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
);
const OPTIONS = ['agent_id', 'nats_url', 'nkey_seed', 'prefix'];

// The options a second agent on one laptop is set up with. Claude Code 2.1.330 takes options only
// from the manifest's top level: declared under a channel, `claude plugin install --config`
// answers "declares no userConfig options", nothing can be entered, and the session falls back to
// ~/.cosmicwave/agent.json, joining as the laptop's first agent (found in the 0.8.0 test run).
describe('plugin.json options', () => {
  it('declares the four options at the top level', () => {
    expect(Object.keys(manifest.userConfig ?? {})).toEqual(OPTIONS);
  });

  it('declares none under the channel, where Claude Code does not read them', () => {
    expect(manifest.channels).toEqual([{ server: 'mesh', displayName: 'Cosmicwave' }]);
  });

  it('gives the server every declared option, and no option that is not declared', () => {
    const used = Object.values(manifest.mcpServers.mesh?.env ?? {}).map(
      (value) => /^\$\{user_config\.([a-z_]+)\}$/.exec(value)?.[1],
    );
    expect(used).toEqual(OPTIONS);
  });

  it('keeps the seed out of settings.json, and makes no option required', () => {
    // A required option would stop the server starting for a member who joins by invite, whose
    // options stay empty (/cmw:join fills ~/.cosmicwave/agent.json).
    const options = manifest.userConfig ?? {};
    expect(options.nkey_seed?.sensitive).toBe(true);
    expect(OPTIONS.filter((key) => options[key]?.required)).toEqual([]);
    expect(OPTIONS.filter((key) => options[key]?.sensitive)).toEqual(['nkey_seed']);
  });
});
