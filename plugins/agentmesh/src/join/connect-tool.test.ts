import type { RpcResult } from '@agentmesh/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigResult } from '../config';
import { CONNECT_TOOL, callConnectTool, connectToolListing } from './connect-tool';

const resolved: ConfigResult = {
  ok: true,
  config: {
    agentId: 'riya-agent',
    servers: ['tls://mesh.acme.dev:4222'],
    prefix: 'mesh',
    heartbeatSeconds: 20,
  },
};

describe('connect', () => {
  it('is listed with an empty input', () => {
    expect(connectToolListing.name).toBe(CONNECT_TOOL);
    expect(connectToolListing.inputSchema.type).toBe('object');
  });

  it('reports the problems of settings that do not load', async () => {
    const onConnected = vi.fn();
    const result = await callConnectTool({
      resolve: () => ({
        ok: false,
        problems: ['agent_id is not set', 'nats_url is not set'],
        unenrolled: true,
      }),
      onConnected,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('agent_id is not set; nats_url is not set');
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('connects the session as the saved agent', async () => {
    const onConnected = vi.fn(async () => null);
    const result = await callConnectTool({ resolve: () => resolved, onConnected });
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledWith('riya-agent');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Connected as riya-agent. Run /agentmesh:activate.' }],
    });
  });

  it('says who connected, for whom, and the Git rules, as the instructions do', async () => {
    const hello = {
      self: { id: 'riya-agent', displayName: "Riya's Claude", owner: null },
      mesh: { name: 'acme' },
      policy: {
        git: {
          integrationBranch: 'dev',
          protectedBranches: [],
          branchTemplate: 'mesh/{agent}/{task}',
          agentsMayMergeInto: [],
        },
      },
    } as unknown as RpcResult<'session.hello'>;
    const result = await callConnectTool({
      resolve: () => resolved,
      onConnected: async () => hello,
    });
    expect(result.content[0]?.text).toBe(
      [
        'Connected as riya-agent.',
        `You are riya-agent (Riya's Claude) on the AgentMesh "acme": your teammates' Claude Code agents and humans work together through it.`,
        'Git: integration branch `dev`; branches `mesh/{agent}/{task}`; agents may merge into nothing; humans merge nothing.',
        'Run /agentmesh:activate.',
      ].join('\n'),
    );
  });

  it('reports a failed connection', async () => {
    const result = await callConnectTool({
      resolve: () => resolved,
      onConnected: async () => {
        throw new Error('hub unreachable');
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('hub unreachable');
  });
});
