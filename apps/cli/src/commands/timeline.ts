import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectOnce, RpcClient } from '@agentmesh/bus';
import { agentmeshDir, MeshError } from '@agentmesh/common';
import { inboxPrefix } from '@agentmesh/protocol';
import { parseCommandArgs } from '../args';
import type { AgentSettings, CliContext, Command, ObserveCall } from '../context';

/**
 * One connection as the saved agent, one `observe.timeline` call, then close. The hub answers
 * only into the caller's own inbox, so the connection takes the agent's inbox prefix.
 */
export const callTimeline: ObserveCall = async (s, params) => {
  const nc = await connectOnce({
    servers: [s.natsUrl],
    name: `timeline-${s.agentId}`,
    inboxPrefix: inboxPrefix(s.agentId),
    credentials: { nkeySeed: s.nkeySeed },
  });
  try {
    return await new RpcClient(nc, s.prefix, s.agentId).call('observe.timeline', params);
  } finally {
    await nc.close();
  }
};

const NOT_JOINED =
  'No agent settings found: run /agentmesh:join or agentmesh agent-setup --write first.';

function readSettings(ctx: CliContext): AgentSettings {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(agentmeshDir(ctx.homeDir), 'agent.json'), 'utf8'));
  } catch {
    throw new MeshError('not_found', NOT_JOINED);
  }
  const { agentId, natsUrl, nkeySeed, prefix } = raw;
  if (typeof agentId !== 'string' || typeof natsUrl !== 'string' || typeof nkeySeed !== 'string') {
    throw new MeshError('not_found', NOT_JOINED);
  }
  return { agentId, natsUrl, nkeySeed, prefix: typeof prefix === 'string' ? prefix : 'mesh' };
}

export const timelineCommand: Command = {
  name: 'timeline',
  summary: "Show the mesh's event timeline (operators only)",
  help: `Usage: agentmesh timeline [--agent <id>] [--session <id>] [--thread thr-N] [--since 2h]
                          [--until <time>] [--limit N] [--json]

For this mesh's operators only (humans in observability.viewers); anyone else is refused.
Reads ~/.agentmesh/agent.json, asks the hub and prints the timeline: ids, counts, outcomes and
timings, never message contents. --since and --until take an ISO time or a duration (30m, 2h, 1d).

--json   one event per line`,
  async run(argv, ctx) {
    const { values: v } = parseCommandArgs(
      argv,
      {
        agent: { type: 'string' },
        session: { type: 'string' },
        thread: { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      { min: 0, max: 0, names: '' },
    );
    const settings = readSettings(ctx);
    const params = {
      ...(v.agent ? { agent: v.agent } : {}),
      ...(v.session ? { session: v.session } : {}),
      ...(v.thread ? { thread: v.thread } : {}),
      ...(v.since ? { since: v.since } : {}),
      ...(v.until ? { until: v.until } : {}),
      ...(v.limit ? { limit: Number(v.limit) } : {}),
    };
    try {
      const r = await (ctx.observeCall ?? callTimeline)(settings, params);
      if (v.json) for (const e of r.events) ctx.stdout(JSON.stringify(e));
      else ctx.stdout(r.text);
      return 0;
    } catch (error) {
      if (error instanceof MeshError) {
        ctx.stderr(`error: ${error.message}`);
        return 1;
      }
      throw error;
    }
  },
};
