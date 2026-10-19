import {
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  SlashCommandBuilder,
} from 'discord.js';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

const plan = new SlashCommandBuilder()
  .setName('plan')
  .setDescription('Team planning sessions: every agent proposes, discusses, then tasks are created')
  .addSubcommand((s) =>
    s
      .setName('start')
      .setDescription('Start a planning session with the agents')
      .addStringOption((o) =>
        o.setName('topic').setDescription('What to plan').setRequired(true).setMaxLength(2000),
      )
      .addStringOption((o) =>
        o.setName('participants').setDescription('Agent ids, comma-separated (default: all)'),
      )
      .addStringOption((o) =>
        o
          .setName('facilitator')
          .setDescription('Agent who synthesizes the plan')
          .setAutocomplete(true),
      )
      .addIntegerOption((o) =>
        o.setName('minutes').setDescription('Minutes per round').setMinValue(1).setMaxValue(1440),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('status')
      .setDescription('Show a planning session')
      .addStringOption((o) =>
        o.setName('plan').setDescription('Plan id, e.g. plan-7').setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('approve')
      .setDescription('Approve a plan waiting for approval (creates its tasks)')
      .addStringOption((o) => o.setName('plan').setDescription('Plan id').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('cancel')
      .setDescription('Cancel a planning session')
      .addStringOption((o) => o.setName('plan').setDescription('Plan id').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Why')),
  );

const task = new SlashCommandBuilder()
  .setName('task')
  .setDescription('Create and manage team tasks')
  .addSubcommand((s) =>
    s
      .setName('create')
      .setDescription('Create a task (routed to the area owner unless you pick an assignee)')
      .addStringOption((o) =>
        o.setName('title').setDescription('Short title').setRequired(true).setMaxLength(200),
      )
      .addStringOption((o) =>
        o.setName('description').setDescription('Details and context').setMaxLength(4000),
      )
      .addStringOption((o) => o.setName('area').setDescription('Code area').setAutocomplete(true))
      .addStringOption((o) => o.setName('repo').setDescription('owner/name'))
      .addStringOption((o) =>
        o.setName('assignee').setDescription('Agent to assign').setAutocomplete(true),
      )
      .addStringOption((o) =>
        o
          .setName('priority')
          .setDescription('Priority')
          .addChoices(...PRIORITIES.map((p) => ({ name: p, value: p }))),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('list')
      .setDescription('List open tasks')
      .addStringOption((o) =>
        o.setName('assignee').setDescription('Agent, or "unassigned"').setAutocomplete(true),
      )
      .addStringOption((o) => o.setName('state').setDescription('Only this state')),
  )
  .addSubcommand((s) =>
    s
      .setName('show')
      .setDescription('Show a task')
      .addStringOption((o) =>
        o.setName('task').setDescription('Task id, e.g. task-42').setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('assign')
      .setDescription('Assign a task to an agent')
      .addStringOption((o) => o.setName('task').setDescription('Task id').setRequired(true))
      .addStringOption((o) =>
        o.setName('agent').setDescription('Agent').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('cancel')
      .setDescription('Cancel a task')
      .addStringOption((o) => o.setName('task').setDescription('Task id').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Why')),
  );

const ask = new SlashCommandBuilder()
  .setName('ask')
  .setDescription('Ask an agent something; the conversation appears in the council channel')
  .addStringOption((o) =>
    o.setName('agent').setDescription('Agent').setRequired(true).setAutocomplete(true),
  )
  .addStringOption((o) =>
    o.setName('question').setDescription('Your question').setRequired(true).setMaxLength(4000),
  );

const mesh = new SlashCommandBuilder()
  .setName('mesh')
  .setDescription('Mesh status, the kill switch, and members')
  .addSubcommand((s) => s.setName('status').setDescription('Who is online, open work, pause state'))
  .addSubcommand((s) =>
    s
      .setName('pause')
      .setDescription('Kill switch: hold every delivery to agents (admins)')
      .addStringOption((o) => o.setName('reason').setDescription('Why')),
  )
  .addSubcommand((s) =>
    s.setName('resume').setDescription('Resume delivery and release held messages (admins)'),
  )
  .addSubcommand((s) =>
    s
      .setName('invite')
      .setDescription('Invite someone: they get a one-time join code by DM (admins)')
      .addUserOption((o) => o.setName('user').setDescription('Who to invite').setRequired(true))
      .addStringOption((o) =>
        o
          .setName('id')
          .setDescription('Their mesh id, e.g. dana')
          .setRequired(true)
          .setMaxLength(40),
      )
      .addStringOption((o) =>
        o.setName('name').setDescription('Display name (default: Discord name)'),
      )
      .addStringOption((o) => o.setName('roles').setDescription('Comma-separated, e.g. admin'))
      .addStringOption((o) =>
        o.setName('skills').setDescription('Comma-separated, e.g. backend, api'),
      )
      .addStringOption((o) => o.setName('agent').setDescription('Agent id (default: <id>-agent)')),
  )
  .addSubcommand((s) =>
    s
      .setName('uninvite')
      .setDescription("Cancel someone's open invite, so its code stops working (admins)")
      .addStringOption((o) =>
        o.setName('person').setDescription('Their mesh id').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove an invited member: their agent is disconnected and refused (admins)')
      .addStringOption((o) =>
        o.setName('person').setDescription('Their mesh id').setRequired(true).setAutocomplete(true),
      ),
  );

/** Every slash command, as registered with Discord. */
export function commandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [plan, task, ask, mesh].map((c) => c.toJSON());
}

/** Read-only commands reply only to the person who ran them. */
export function isPrivateCommand(command: string, subcommand: string | null): boolean {
  return (
    subcommand === 'status' || subcommand === 'list' || subcommand === 'show' || command === 'mesh'
  );
}
