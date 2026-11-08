import { connectOnce, RpcClient, refusedOrUnreachable } from '@agentmesh/bus';
import { existingMesh, MeshError } from '@agentmesh/common';
import { inboxPrefix } from '@agentmesh/protocol';
import { parseCommandArgs, usageError } from '../args';
import type { AgentSettings, CliContext, Command, ObserveCall } from '../context';
import { keyWords } from '../setup/checks/agent';

/**
 * One connection as the saved agent, one `observe.timeline` call, then close. The hub answers
 * only into the caller's own inbox, so the connection takes the agent's inbox prefix. A failed
 * connect reads as join's does: refused, dropped or unreachable, never the server's own text.
 */
export const callTimeline: ObserveCall = async (s, params) => {
  let nc: Awaited<ReturnType<typeof connectOnce>>;
  try {
    nc = await connectOnce({
      servers: [s.natsUrl],
      name: `timeline-${s.agentId}`,
      inboxPrefix: inboxPrefix(s.agentId),
      credentials: { nkeySeed: s.nkeySeed },
    });
  } catch (error) {
    throw refusedOrUnreachable(error, s.natsUrl, keyWords(s.agentId, s.natsUrl));
  }
  try {
    return await new RpcClient(nc, s.prefix, s.agentId).call('observe.timeline', params);
  } finally {
    await nc.close();
  }
};

const NOT_JOINED =
  'No agent settings found: run /agentmesh:join or agentmesh agent-setup --write first.';

function readSettings(ctx: CliContext): AgentSettings {
  const { agentId, natsUrl, nkeySeed, prefix = 'mesh' } = existingMesh(ctx.homeDir) ?? {};
  if (!agentId || !natsUrl || !nkeySeed) throw new MeshError('not_found', NOT_JOINED);
  return { agentId, natsUrl, nkeySeed, prefix };
}

/** `--limit`: a positive whole number, or a usage error (exit 2) before anything connects. */
function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw usageError('--limit must be a positive whole number');
  return Number(value);
}

/** The text, or with `--json` one event per line and a note on stderr when it was cut short. */
function print(r: Awaited<ReturnType<ObserveCall>>, json: boolean, ctx: CliContext): void {
  if (!json) {
    ctx.stdout(r.text);
    return;
  }
  for (const e of r.events) ctx.stdout(JSON.stringify(e));
  if (r.truncated) {
    ctx.stderr(
      'note: truncated: only the newest events are shown; narrow the window or raise --limit',
    );
  }
}

export const timelineCommand: Command = {
  name: 'timeline',
  summary: "Show the mesh's event timeline (operators only)",
  help: `Usage: agentmesh timeline [--agent <id>] [--session <id>] [--thread thr-N] [--since 2h]
                          [--until <time>] [--limit N] [--json]

For this mesh's operators only (humans in observability.viewers); anyone else is refused.
Reads ~/.agentmesh/agent.json, asks the hub and prints the timeline: ids, counts, outcomes and
timings, never message contents. AGENTMESH_* environment overrides are ignored. --since and
--until take an ISO time or a duration (30m, 2h, 1d). --limit is at most 1000.

--json   one event per line (a note on stderr says when the hub cut it short)`,
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
    const limit = parseLimit(v.limit);
    const settings = readSettings(ctx);
    const params = {
      ...(v.agent ? { agent: v.agent } : {}),
      ...(v.session ? { session: v.session } : {}),
      ...(v.thread ? { thread: v.thread } : {}),
      ...(v.since ? { since: v.since } : {}),
      ...(v.until ? { until: v.until } : {}),
      ...(limit ? { limit } : {}),
    };
    try {
      print(await (ctx.observeCall ?? callTimeline)(settings, params), v.json, ctx);
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
