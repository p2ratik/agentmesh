import { parseCommandArgs } from '../args';
import { type Command, resolveFrom } from '../context';
import { findExamplesDir } from '../lib/repo-paths';
import { scaffold } from '../lib/scaffold';

export const initCommand: Command = {
  name: 'init',
  summary: 'Scaffold a mesh config directory from the examples',
  help: `Usage: agentmesh init [dir] [--force]

Copies config/examples (mesh.yaml, workflows/, rules/, policy/) into <dir>
(default: ./config). Refuses to overwrite existing files unless --force.`,
  run(argv, ctx) {
    const { values, positionals } = parseCommandArgs(
      argv,
      { force: { type: 'boolean' } },
      { min: 0, max: 1, names: '[dir]' },
    );
    const target = resolveFrom(ctx, positionals[0] ?? 'config');
    const files = scaffold(findExamplesDir(), target, values.force ?? false);
    ctx.stdout(
      [
        `Created ${files.length} files in ${target}:`,
        ...files.map((f) => `  ${f}`),
        '',
        'Next:',
        '  1. Edit mesh.yaml: your humans (Discord user ids), agents, areas and git policy.',
        `  2. agentmesh validate --config ${target}`,
        `  3. agentmesh keys add hub --config ${target}   (then one per agent and service)`,
        `  4. agentmesh nats-config --config ${target}`,
      ].join('\n'),
    );
    return 0;
  },
};
