import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentmeshDir, existingMesh, MeshError } from '@agentmesh/common';
import { parseCommandArgs } from '../../args';
import type { Command } from '../../context';
import { loadTopology } from '../../lib/config-files';
import { writePrivateFile } from '../../lib/files';
import { agentJson } from '../../render/agent-setup';
import { agentIdOf } from '../../setup/answers';
import { NATS_PORT } from '../../setup/defaults';
import { loadAnswers, markDone, workspaceFrom } from '../../setup/workspace';

export const setupAdminCommand: Command = {
  name: 'setup admin',
  summary: "Save the admin's agent settings to ~/.agentmesh/agent.json on this machine",
  help: `Usage: agentmesh setup admin --dir <workspace> [--replace]

Writes ~/.agentmesh/agent.json for <admin>-agent with the seed setup render made, the
hub's NATS URL and the mesh prefix, so the plugin connects as the admin's agent. It
refuses to replace settings for another agent or hub unless --replace.`,
  run(argv, ctx) {
    const { values } = parseCommandArgs(
      argv,
      { dir: { type: 'string' }, replace: { type: 'boolean' } },
      { min: 0, max: 0, names: '' },
    );
    const p = workspaceFrom(ctx, values.dir);
    const a = loadAnswers(p);
    const agentId = agentIdOf(a.admin.id);
    const dir = agentmeshDir(ctx.homeDir);
    const seedFile = join(dir, `${agentId}.nk`);
    if (!existsSync(seedFile)) {
      throw new MeshError('not_found', `No seed at ${seedFile}. Run setup render first.`);
    }
    const natsUrl =
      a.hosting.mode === 'server'
        ? `tls://${a.hosting.publicHost}:${NATS_PORT}`
        : `nats://127.0.0.1:${NATS_PORT}`;

    // A field agent.json lacks never names another mesh.
    const current = existingMesh(ctx.homeDir) ?? {};
    const other =
      (current.agentId ?? agentId) !== agentId || (current.natsUrl ?? natsUrl) !== natsUrl;
    if (other && !values.replace) {
      throw new MeshError(
        'conflict',
        `This laptop is already set up as ${current.agentId ?? 'an agent'} on ${current.natsUrl ?? 'a mesh'}. ` +
          `Run again with --replace to switch it to ${a.team.name}; that agent stops working here.`,
      );
    }

    // The workspace's mesh.yaml is the truth after render, and the plugin prefers this prefix.
    const { prefix } = loadTopology(p.configDir, ctx.env).config.mesh;
    const file = join(dir, 'agent.json');
    writePrivateFile(file, agentJson({ agentId, natsUrl, seedFile, prefix }), true);

    const lines = [
      `Saved ${file} for ${agentId}. In Claude Code, call the AgentMesh connect tool, or ` +
        'restart Claude Code with the channel flag. Then run /agentmesh:activate.',
    ];
    if (other) {
      lines.push('Restart Claude Code: the running plugin is still connected to the old mesh.');
    }
    if (a.hosting.mode === 'trial' && a.hosting.testAgent) {
      const testAgent = `${a.admin.id}-test-agent`;
      lines.push(
        '',
        'For the test agent, under a second Claude account (CLAUDE_CONFIG_DIR), run:',
        `  agentmesh agent-setup ${testAgent} --config ${p.configDir} --nats-url ${natsUrl} ` +
          `--seed-file ${join(dir, `${testAgent}.nk`)}`,
      );
    }
    markDone(p, 'admin', new Date());
    ctx.stdout(lines.join('\n'));
    return 0;
  },
};
