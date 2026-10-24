/**
 * The workspace's `CLAUDE.md`. The settings deny rules stop the Read tool only, not a shell
 * `cat`, so this tells every Claude session in the workspace to stay out of the secrets. `cli`
 * is how setup ran the CLI (`cliOf`): it is on no PATH, and later sessions load no skill.
 */
export function renderWorkspaceClaudeMd(cli: string): string {
  return `# AgentMesh workspace

This folder was written by \`agentmesh setup\` and holds the team's hub secrets.

\`agentmesh\` below is the CLI bundled in the AgentMesh plugin. Run it as \`${cli}\`. A plugin update removes that path; then use \`node "<home>/.claude/plugins/cache/agentmesh/agentmesh/<version>/dist/cli.js"\` with the newest \`<version>\`. Never run \`npx agentmesh\`: that is an unrelated npm package.

- Never ask the user to paste the Discord bot token, an invite code or any key into the chat; secrets go into files the user edits.
- Never open, read, \`cat\`, \`grep\`, print or search \`deploy/.env\` or anything in \`deploy/secrets/\`, and never run \`docker compose config\` (it prints \`.env\` values). If you need a non-secret value from \`.env\`, ask the user.
- Inspect the setup with the \`agentmesh\` CLI: \`setup status --dir .\` and \`doctor --dir .\`.
- To change the team's config, edit the files in \`config/\`, then run \`agentmesh setup deploy --dir .\`. It checks the config with the real \`.env\` values before it copies anything, then restarts the hub with it. Don't run \`agentmesh validate\` here: it cannot read \`.env\`, so it always fails.
- Agents never run \`/mesh\` admin commands. Print the command and let the user run it in Discord.
`;
}
