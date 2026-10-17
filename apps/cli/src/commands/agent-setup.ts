import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, MeshError } from '@agentmesh/common';
import { ConfigIndex } from '@agentmesh/config';
import { parseCommandArgs } from '../args';
import { type Command, configPathFrom, resolveFrom } from '../context';
import { loadTopology } from '../lib/config-files';
import { writePrivateFile } from '../lib/files';
import { findRepoRoot } from '../lib/repo-paths';
import { type AgentSetupInput, agentJson, renderAgentSetup } from '../render/agent-setup';

export const agentSetupCommand: Command = {
  name: 'agent-setup',
  summary: "Print a developer's laptop setup (plugin, options, permissions, launch)",
  help: `Usage: agentmesh agent-setup <agent-id> [--config <dir>] [--nats-url <url>]
                             [--seed-file <path>] [--marketplace <src>] [--write]

Prints the exact steps for the developer who owns <agent-id>. --write saves
~/.agentmesh/agent.json, which the plugin reads when its options are empty.`,
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
    // `~/…` stays as written: the steps are often for a teammate's machine, not this one.
    const given = values['seed-file'] ?? `~/.agentmesh/${agentId}.nk`;
    const seedFile = given.startsWith('~') ? given : resolveFrom(ctx, given);
    const input: AgentSetupInput = {
      agentId,
      displayName: index.displayName(agentId),
      owner: agent.owner,
      natsUrl: values['nats-url'] ?? config.nats.servers[0] ?? 'nats://localhost:4222',
      seedFile,
      seedFound: existsSync(expandHome(seedFile, ctx.homeDir)),
      prefix: config.mesh.prefix,
      marketplace: values.marketplace ?? findRepoRoot() ?? '<path or GitHub repo of AgentMesh>',
      wroteConfig: null,
    };
    if (values.write) {
      const file = join(ctx.homeDir, '.agentmesh', 'agent.json');
      writePrivateFile(file, agentJson(input), true);
      input.wroteConfig = file;
    }
    ctx.stdout(renderAgentSetup(input));
    return 0;
  },
};
