export interface AgentSetupInput {
  agentId: string;
  displayName: string;
  owner: string;
  natsUrl: string;
  /** Path of the agent's nkey seed file; `~/…` is expanded on the machine that reads it. */
  seedFile: string;
  seedFound: boolean;
  prefix: string;
  /** Source for `claude plugin marketplace add` (repo path or GitHub repo). */
  marketplace: string;
  /** Where `--write` saved the fallback config, or null when it was not used. */
  wroteConfig: string | null;
}

/** The permission rule that lets the mesh tools run without a prompt per call. */
export const MESH_TOOLS_ALLOW_RULE = 'mcp__plugin_agentmesh_mesh__*';
export const PLUGIN_REF = 'agentmesh@agentmesh';

/** The `~/.agentmesh/agent.json` fallback config the plugin reads. */
export function agentJson(
  input: Pick<AgentSetupInput, 'agentId' | 'natsUrl' | 'seedFile' | 'prefix'>,
): string {
  const value = {
    agentId: input.agentId,
    natsUrl: input.natsUrl,
    nkeySeed: input.seedFile,
    prefix: input.prefix,
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

const isLocal = (url: string): boolean => /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);

/** Step-by-step instructions for one developer's laptop. Pure. */
export function renderAgentSetup(input: AgentSetupInput): string {
  const settings = JSON.stringify({ permissions: { allow: [MESH_TOOLS_ALLOW_RULE] } }, null, 2);
  const lines = [
    `AgentMesh setup for ${input.agentId} (${input.displayName}, owned by ${input.owner})`,
    '',
    '1. Your key',
    `   The mesh admin creates it with \`agentmesh keys add ${input.agentId}\` and sends you the seed`,
    '   privately. Never commit it or paste it into a chat.',
    `   Seed file: ${input.seedFile} (${input.seedFound ? 'found' : 'NOT FOUND yet'})`,
    '',
    '2. Install the plugin',
    `   claude plugin marketplace add ${input.marketplace}`,
    `   claude plugin install ${PLUGIN_REF}`,
    '',
    '3. Plugin settings (enter these when Claude Code asks for the plugin options)',
    `   agent_id   ${input.agentId}`,
    `   nats_url   ${input.natsUrl}`,
    `   nkey_seed  ${input.seedFile}`,
    `   prefix     ${input.prefix}`,
    '',
    '4. Let the mesh tools run without a prompt per call: merge into ~/.claude/settings.json',
    ...settings.split('\n').map((l) => `   ${l}`),
    '',
    '5. Start Claude Code with the mesh channel',
    `   claude --dangerously-load-development-channels plugin:${PLUGIN_REF}`,
    `   (once your organization allowlists the plugin: claude --channels plugin:${PLUGIN_REF})`,
  ];
  if (isLocal(input.natsUrl)) {
    lines.push(
      '',
      'note: nats_url points at this machine. Unless the hub runs here, pass',
      '      --nats-url nats://<hub-tailnet-name>:4222',
    );
  }
  lines.push(
    '',
    input.wroteConfig
      ? `Wrote ${input.wroteConfig}. It fills in empty options such as the seed, and its prefix wins over the prefix option. agent_id and nats_url must still be entered in the plugin options, and must match this file or the plugin ignores it.`
      : 'Tip: add --write to save these values to ~/.agentmesh/agent.json. It fills in empty options such as the seed, and its prefix wins over the prefix option.',
  );
  return lines.join('\n');
}
