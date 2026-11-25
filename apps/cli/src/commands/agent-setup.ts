import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, homeDirName, MeshError, meshHome } from '@cosmicwave/common';
import { ConfigIndex } from '@cosmicwave/config';
import { parseCommandArgs } from '../args';
import { type Command, configPathFrom, resolveFrom } from '../context';
import { loadTopology } from '../lib/config-files';
import { writePrivateFile } from '../lib/files';
import { findRepoRoot } from '../lib/repo-paths';
import { type AgentSetupInput, agentJson, renderAgentSetup } from '../render/agent-setup';

export const agentSetupCommand: Command = {
  name: 'agent-setup',
  summary: "Print a developer's laptop setup (plugin, options, permissions, launch)",
  help: `Usage: cmw agent-setup <agent-id> [--config <dir>] [--nats-url <url>]
                             [--seed-file <path>] [--marketplace <src>] [--write]

Prints the exact steps for the developer who owns <agent-id>. --write saves
~/.cosmicwave/agent.json, which supplies every plugin option left empty, so
with it the options can all stay empty. The plugin ignores the file when the
agent_id or nats_url option names another agent or hub.`,
  run(argv, ctx) {
    const { values, positionals } = parseCommandArgs(
      argv,
      {
        config: { type: 'string' },
        'nats-url': { type: 'string' },
        'seed-file': { type: 'string' },
        marketplace: { type: 'string' },
        write: { type: 'boolean' },
      },
      { min: 1, max: 1, names: '<agent-id>' },
    );
    const agentId = positionals[0] ?? '';
    const { config } = loadTopology(configPathFrom(ctx, values.config), ctx.env);
    const index = new ConfigIndex(config);
    const agent = index.agent(agentId);
    if (!agent) {
      throw new MeshError(
        'not_found',
        `No agent "${agentId}". Agents: ${index
          .agents()
          .map((a) => a.id)
          .join(', ')}`,
      );
    }
    // `~/…` stays as written: the steps are often for a teammate's machine, not this one. The
    // folder is this laptop's (~/.agentmesh until it moves), so --write points into it.
    const given = values['seed-file'] ?? `~/${homeDirName(ctx.homeDir)}/${agentId}.nk`;
    const seedFile = given.startsWith('~') ? given : resolveFrom(ctx, given);
    const input: AgentSetupInput = {
      agentId,
      displayName: index.displayName(agentId),
      owner: agent.owner,
      natsUrl: values['nats-url'] ?? config.nats.servers[0] ?? 'nats://localhost:4222',
      seedFile,
      seedFound: existsSync(expandHome(seedFile, ctx.homeDir)),
      prefix: config.mesh.prefix,
      marketplace: values.marketplace ?? findRepoRoot() ?? '<path or GitHub repo of Cosmicwave>',
      wroteConfig: null,
    };
    if (values.write) {
      const file = join(meshHome(ctx.homeDir), 'agent.json');
      writePrivateFile(file, agentJson(input), true);
      input.wroteConfig = file;
    }
    ctx.stdout(renderAgentSetup(input));
    return 0;
  },
};
