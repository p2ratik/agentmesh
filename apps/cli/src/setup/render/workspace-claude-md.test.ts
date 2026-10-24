import { describe, expect, it } from 'vitest';
import { renderWorkspaceClaudeMd } from './workspace-claude-md';

describe('renderWorkspaceClaudeMd', () => {
  it('keeps Claude out of the secrets and away from /mesh admin commands', () => {
    const text = renderWorkspaceClaudeMd('agentmesh');
    expect(text).toMatch(/^# AgentMesh workspace\n/);
    expect(text.split('\n').find((line) => line.startsWith('- '))).toBe(
      '- Never ask the user to paste the Discord bot token, an invite code or any key into the ' +
        'chat; secrets go into files the user edits.',
    );
    expect(text).toContain('`deploy/.env`');
    expect(text).toContain('`deploy/secrets/`');
    expect(text).toContain('never run `docker compose config`');
    expect(text).toContain('`setup status --dir .` and `doctor --dir .`');
    // validate reads only the process env, never deploy/.env, so it always fails here.
    expect(text).not.toContain('agentmesh validate --config config');
    expect(text).toContain("Don't run `agentmesh validate` here");
    expect(text).toContain('then run `agentmesh setup deploy --dir .`');
    expect(text).toContain('Agents never run `/mesh` admin commands');
  });

  it('says how to run the CLI, which is on no PATH, and never npx', () => {
    const cli = 'node "/home/riya/.claude/plugins/cache/agentmesh/agentmesh/0.4.0/dist/cli.js"';
    const text = renderWorkspaceClaudeMd(cli);
    expect(text).toContain(`Run it as \`${cli}\`.`);
    expect(text).toContain(
      '`node "<home>/.claude/plugins/cache/agentmesh/agentmesh/<version>/dist/cli.js"` with the ' +
        'newest `<version>`',
    );
    expect(text).toContain('Never run `npx agentmesh`');
  });
});
