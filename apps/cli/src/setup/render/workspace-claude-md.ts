/**
 * The workspace's `CLAUDE.md`. The settings deny rules stop the Read tool only, not a shell
 * `cat`, so this tells every Claude session in the workspace to stay out of the secrets.
 */
export function renderWorkspaceClaudeMd(): string {
  return `# AgentMesh workspace

This folder was written by \`agentmesh setup\` and holds the team's hub secrets.

- Never ask the user to paste the Discord bot token, an invite code or any key into the chat; secrets go into files the user edits.
- Never open, read, \`cat\`, \`grep\`, print or search \`deploy/.env\` or anything in \`deploy/secrets/\`, and never run \`docker compose config\` (it prints \`.env\` values). If you need a non-secret value from \`.env\`, ask the user.
- Inspect the setup with the \`agentmesh\` CLI: \`setup status --dir .\` and \`doctor --dir .\`.
- To change the team's config, edit the files in \`config/\`, run \`agentmesh validate --config config\`, then \`agentmesh setup deploy --dir .\`.
- Agents never run \`/mesh\` admin commands. Print the command and let the user run it in Discord.
`;
}
