import type { Logger } from '@agentmesh/common';
import type { ConfigIndex } from '@agentmesh/config';
import {
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  MessageFlags,
} from 'discord.js';
import { authorize, NOT_A_MEMBER } from '../auth';
import { parsePlanButtonId } from '../custom-ids';
import { chunkMessage } from '../discord/chunk';
import { errorText } from '../render/format';
import { actAs, type MeshRpc } from '../rpc';
import { suggest } from './autocomplete';
import { isPrivateCommand } from './definitions';
import { COMMAND_HANDLERS, type CommandContext } from './handlers';

export interface InteractionDeps extends CommandContext {
  rpc: MeshRpc;
  /** Read per interaction: the team changes when members join or leave. */
  index: () => ConfigIndex;
  logger: Logger;
}

/** One handler for every interaction: slash commands, autocomplete and plan buttons. */
export function createInteractionHandler(deps: InteractionDeps) {
  return async (interaction: Interaction): Promise<void> => {
    try {
      if (interaction.isAutocomplete()) await autocomplete(interaction, deps);
      else if (interaction.isChatInputCommand()) await command(interaction, deps);
      else if (interaction.isButton()) await button(interaction, deps);
    } catch (err) {
      deps.logger.error({ err }, 'interaction failed');
    }
  };
}

async function autocomplete(i: AutocompleteInteraction, deps: InteractionDeps): Promise<void> {
  const focused = i.options.getFocused(true);
  const sub = i.options.getSubcommand(false);
  await i.respond(suggest(deps.index(), i.commandName, sub, focused.name, String(focused.value)));
}

async function command(i: ChatInputCommandInteraction, deps: InteractionDeps): Promise<void> {
  const human = authorize(deps.index(), i.user.id);
  if (!human) {
    await i.reply({ content: NOT_A_MEMBER, flags: MessageFlags.Ephemeral });
    return;
  }
  const sub = i.options.getSubcommand(false);
  const handler = COMMAND_HANDLERS[`${i.commandName}.${sub ?? ''}`];
  if (!handler) {
    await i.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
    return;
  }
  await i.deferReply(isPrivateCommand(i.commandName, sub) ? { flags: MessageFlags.Ephemeral } : {});
  try {
    const text = await handler(i, actAs(deps.rpc, human.id, i.id), deps);
    await i.editReply({
      content: chunkMessage(text)[0] ?? 'Done.',
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    await i.editReply({ content: errorText(err), allowedMentions: { parse: [] } });
  }
}

async function button(i: ButtonInteraction, deps: InteractionDeps): Promise<void> {
  const parsed = parsePlanButtonId(i.customId);
  if (!parsed) return;
  const human = authorize(deps.index(), i.user.id);
  if (!human) {
    await i.reply({ content: NOT_A_MEMBER, flags: MessageFlags.Ephemeral });
    return;
  }
  await i.deferUpdate();
  try {
    const call = actAs(deps.rpc, human.id, i.id);
    const plan =
      parsed.action === 'approve'
        ? await call('plan.approve', { planId: parsed.planId })
        : await call('plan.cancel', {
            planId: parsed.planId,
            reason: `cancelled from Discord by ${human.id}`,
          });
    const verb = parsed.action === 'approve' ? '✅ Approved' : '🛑 Cancelled';
    await i.editReply({
      content: `${i.message.content}\n\n${verb} by <@${i.user.id}> — ${plan.id} is now ${plan.state}.`,
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    await i.followUp({ content: errorText(err), flags: MessageFlags.Ephemeral });
  }
}
