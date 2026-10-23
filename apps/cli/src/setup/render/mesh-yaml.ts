import type { MeshConfigInput } from '@agentmesh/config';
import { stringify } from 'yaml';
import { adminRoles, agentIdOf, type SetupAnswers } from '../answers';
import { NATS_PORT } from '../defaults';

const HEADER = `# Written by \`agentmesh setup render\` from setup-answers.json. It is yours now: edit it,
# check it with \`agentmesh validate\`, and push it with \`agentmesh setup deploy\`.
# Every option is described in docs/configuration.md.
`;

/** `${NAME:-}`: the hub fills it from deploy/.env when it loads the config. */
const fromEnv = (name: string): string => `\${${name}:-}`;

/** The first `mesh.yaml` of a new mesh: the admin, their agent, areas and Discord. No keys yet. */
export function renderMeshYaml(a: SetupAnswers): string {
  const { admin, hosting } = a;
  const publicNats = hosting.mode === 'server' ? `tls://${hosting.publicHost}:${NATS_PORT}` : null;
  const agents: MeshConfigInput['agents'] = [
    {
      id: agentIdOf(admin.id),
      owner: admin.id,
      displayName: `${admin.name}'s Claude`,
      skills: admin.skills,
      ...(admin.githubUsername
        ? { avatarUrl: `https://github.com/${admin.githubUsername}.png` }
        : {}),
    },
  ];
  if (hosting.mode === 'trial' && hosting.testAgent) {
    agents.push({
      id: `${admin.id}-test-agent`,
      owner: admin.id,
      displayName: `${admin.name}'s test Claude`,
      skills: admin.skills,
    });
  }
  const config: MeshConfigInput = {
    version: 1,
    mesh: { name: a.team.meshName, prefix: 'mesh' },
    nats: { servers: publicNats ?? `nats://127.0.0.1:${NATS_PORT}` },
    hub: { dataDir: './data', http: { enabled: true, host: '0.0.0.0', port: 8787 } },
    humans: [{ id: admin.id, displayName: admin.name, roles: adminRoles(a) }],
    agents,
    services: [{ id: 'discord-bridge', role: 'bridge', canActAsHumans: true }],
    areas: a.areas.map((area) => ({ ...area, owners: area.owners.map(agentIdOf) })),
    git: {
      ...a.git,
      branchTemplate: 'agent/{owner}/{task}-{slug}',
      agentsMayMergeInto: [a.git.integrationBranch],
    },
    policy: { instructionsFile: 'policy/team-policy.md' },
    planning: { requireApproval: a.decisions.plansNeedApproval },
    ...(publicNats ? { enrollment: { natsUrl: publicNats } } : {}),
    discord: {
      enabled: true,
      token: fromEnv('DISCORD_BOT_TOKEN'),
      applicationId: fromEnv('DISCORD_APP_ID'),
      guildId: fromEnv('DISCORD_GUILD_ID'),
      provision: { enabled: true, category: 'Agent Mesh' },
    },
  };
  return HEADER + stringify(config);
}
