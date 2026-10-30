import type { SetupAnswers } from '../answers';
import { NATS_PORT } from '../defaults';

/**
 * One `/mesh invite` line per teammate, for the admin to run in Discord (spec §4 step 7).
 * An admin among the people carries `admin` in their roles already. Pure.
 */
export function renderInviteLines(a: SetupAnswers): string[] {
  return a.people.map((p) =>
    [
      `/mesh invite user:@${p.discordUsername} id:${p.id} name:${p.name}`,
      ...(p.roles.length > 0 ? [`roles:${p.roles.join(',')}`] : []),
      ...(p.skills.length > 0 ? [`skills:${p.skills.join(',')}`] : []),
    ].join(' '),
  );
}

/** The note the admin sends teammates: install before the invite, since codes expire. Pure. */
export function renderJoinNote(i: {
  team: string;
  marketplace: string;
  publicHost: string;
}): string {
  return [
    `1. Join the ${i.team} Discord server and allow DMs from its members.`,
    `2. Run \`claude plugin marketplace add ${i.marketplace}\` and \`claude plugin install agentmesh@agentmesh\`.`,
    '3. Add `"mcp__plugin_agentmesh_mesh__*"` to `permissions.allow` in `~/.claude/settings.json`, and leave the plugin options empty.',
    '4. When the invite DM arrives, save the code to `~/.agentmesh/invite.txt`, never in a chat.',
    '5. Start `claude --dangerously-load-development-channels plugin:agentmesh@agentmesh`.',
    `6. Run \`/agentmesh:join\` and confirm that the hub is \`${i.publicHost}:${NATS_PORT}\`.`,
    '7. Say yes when Claude offers automatic plugin updates, or turn them on later in `/plugin` → Marketplaces → agentmesh → Enable auto-update.',
    '8. Run `/agentmesh:activate`.',
    '',
    'Install first: codes expire 24 hours after the invite.',
  ].join('\n');
}
