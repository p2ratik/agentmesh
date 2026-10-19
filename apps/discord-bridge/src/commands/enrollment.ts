import type { RpcParamsInput, RpcResult } from '@agentmesh/protocol';
import type { ChatInputCommandInteraction, User } from 'discord.js';
import type { HumanCall } from '../rpc';
import { splitIds } from './params';

type Invite = RpcResult<'enrollment.invite'>;

const when = (iso: string) => `<t:${Math.floor(Date.parse(iso) / 1000)}:R>`;

/** `/mesh invite` options → `enrollment.invite` params. Pure. */
export function inviteParams(o: {
  user: Pick<User, 'id' | 'globalName' | 'username'>;
  id: string;
  name: string | null;
  roles: string | null;
  skills: string | null;
  agent: string | null;
}): RpcParamsInput<'enrollment.invite'> {
  return {
    humanId: o.id.trim(),
    displayName: o.name?.trim() || o.user.globalName || o.user.username,
    discordUserId: o.user.id,
    roles: splitIds(o.roles) ?? [],
    skills: splitIds(o.skills) ?? [],
    ...(o.agent ? { agentId: o.agent.trim() } : {}),
  };
}

/** The DM: the only place the code is ever written. Pure. */
export function inviteDm(invite: Invite, invitedBy: string): string {
  return [
    `You're invited to join the team's AgentMesh as **${invite.agentId}** (invited by ${invitedBy}).`,
    '',
    '1. Save the code below to `~/.agentmesh/invite.txt`. Do not paste it into a chat: it is a one-time secret.',
    '2. In Claude Code with the AgentMesh plugin installed, run `/agentmesh:join`.',
    `It expires ${when(invite.expiresAt)} and works once.`,
    '',
    `\`\`\`\n${invite.code}\n\`\`\``,
  ].join('\n');
}

/** The admin's (private) reply. Never contains the code. Pure. */
export function inviteSent(invite: Invite, userId: string): string {
  return `✉️ Sent invite **${invite.inviteId}** to <@${userId}> by DM. They join as **${invite.agentId}**; it expires ${when(invite.expiresAt)}.`;
}

export function inviteNotDelivered(inviteId: string, userId: string, cancelled: boolean): string {
  return cancelled
    ? `⚠️ Couldn't DM <@${userId}> (they may not accept DMs from server members), so invite **${inviteId}** was cancelled. Ask them to allow DMs, then invite again.`
    : `⚠️ Couldn't DM <@${userId}>, and cancelling invite **${inviteId}** failed. It expires on its own; nobody has the code.`;
}

/**
 * Creates the invite, DMs the code, and cancels the invite if the DM fails, so
 * an undelivered code never stays valid. The code goes nowhere but the DM.
 */
export async function runInvite(i: ChatInputCommandInteraction, call: HumanCall): Promise<string> {
  const user = i.options.getUser('user', true);
  const invite = await call(
    'enrollment.invite',
    inviteParams({
      user,
      id: i.options.getString('id', true),
      name: i.options.getString('name'),
      roles: i.options.getString('roles'),
      skills: i.options.getString('skills'),
      agent: i.options.getString('agent'),
    }),
  );
  try {
    await user.send({ content: inviteDm(invite, i.user.username), allowedMentions: { parse: [] } });
  } catch {
    const cancelled = await call('enrollment.cancelInvite', { inviteId: invite.inviteId })
      .then((r) => r.cancelled)
      .catch(() => false);
    return inviteNotDelivered(invite.inviteId, user.id, cancelled);
  }
  return inviteSent(invite, user.id);
}

export async function runRemove(i: ChatInputCommandInteraction, call: HumanCall): Promise<string> {
  const humanId = i.options.getString('person', true).trim();
  const result = await call('enrollment.remove', { humanId });
  return result.removed
    ? `🚪 Removed **${humanId}**: ${result.agentIds.join(', ')} disconnected and refused from now on.`
    : `**${humanId}** is not an active enrolled member.`;
}
