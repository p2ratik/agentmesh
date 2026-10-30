import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseCommandArgs } from '../args';
import { type CliContext, type Command, resolveFrom } from '../context';
import { marketplaceSource, setAutoUpdate } from '../lib/claude-settings';
import { writeFileAtomic } from '../lib/files';
import { DEFAULT_MARKETPLACE_NAME } from '../setup/defaults';

/** Claude Code's config folder: `$CLAUDE_CONFIG_DIR` (a second account), else `~/.claude`. */
export function claudeConfigDir(ctx: CliContext): string {
  const dir = ctx.env.CLAUDE_CONFIG_DIR;
  return dir ? resolveFrom(ctx, dir) : join(ctx.homeDir, '.claude');
}

/** The file's text, or undefined when it does not exist. Other read errors are thrown. */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Claude Code's record of added marketplaces; unreadable counts as absent. */
function readKnownMarketplaces(configDir: string): string | undefined {
  try {
    return readFileSync(join(configDir, 'plugins', 'known_marketplaces.json'), 'utf8');
  } catch {
    return undefined;
  }
}

export const autoupdateCommand: Command = {
  name: 'autoupdate',
  summary: "Turn Claude Code's automatic plugin updates on (or off) for AgentMesh",
  help: `Usage: agentmesh autoupdate [--off] [--marketplace <name>]

Sets extraKnownMarketplaces.<name>.autoUpdate in your own Claude Code settings.json
($CLAUDE_CONFIG_DIR, else ~/.claude), with the marketplace source Claude Code recorded when you
added it. Nothing else in the file changes, and the file is never printed. Claude Code then
downloads new plugin versions in the background; /reload-plugins or a restart loads them.

--off          turn automatic updates off again
--marketplace  the marketplace's name in Claude Code (default ${DEFAULT_MARKETPLACE_NAME})`,
  run(argv, ctx) {
    const { values } = parseCommandArgs(
      argv,
      {
        off: { type: 'boolean', default: false },
        marketplace: { type: 'string', default: DEFAULT_MARKETPLACE_NAME },
      },
      { min: 0, max: 0, names: '' },
    );
    const name = values.marketplace;
    const on = !values.off;
    const configDir = claudeConfigDir(ctx);
    const file = join(configDir, 'settings.json');
    const current = readIfPresent(file);
    const source = marketplaceSource(readKnownMarketplaces(configDir), name);
    const { text, changed } = setAutoUpdate(current, name, source, on);
    const what = `auto-update for the "${name}" plugin marketplace`;
    if (!changed) {
      ctx.stdout(
        `Auto-update for the "${name}" plugin marketplace was already ${on ? 'on' : 'off'} in ${file}; nothing changed.`,
      );
      return 0;
    }
    if (current === undefined) mkdirSync(configDir, { recursive: true });
    writeFileAtomic(file, text, current === undefined ? 0o600 : statSync(file).mode & 0o777);
    ctx.stdout(
      on
        ? `Turned on ${what} in ${file}. Claude Code downloads new versions in the background; run /reload-plugins or restart Claude Code to load one.`
        : `Turned off ${what} in ${file}.`,
    );
    return 0;
  },
};
