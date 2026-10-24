import { parseCommandArgs } from '../../args';
import type { Command } from '../../context';
import { DEFAULT_MARKETPLACE } from '../../setup/defaults';
import { renderInviteLines, renderJoinNote } from '../../setup/render/invites';
import { loadAnswers, workspaceFrom } from '../../setup/workspace';

export const setupInvitesCommand: Command = {
  name: 'setup invites',
  summary: 'Print the /mesh invite lines and the join note for teammates',
  help: [
    'Usage: agentmesh setup invites --dir <workspace> [--marketplace <source>]',
    '',
    `--marketplace  where teammates install the plugin from (default ${DEFAULT_MARKETPLACE})`,
  ].join('\n'),
  run(argv, ctx) {
    const { values } = parseCommandArgs(
      argv,
      { dir: { type: 'string' }, marketplace: { type: 'string', default: DEFAULT_MARKETPLACE } },
      { min: 0, max: 0, names: '' },
    );
    const a = loadAnswers(workspaceFrom(ctx, values.dir));
    if (a.hosting.mode === 'trial') {
      ctx.stdout(
        'Teammates cannot join a trial on this machine. Run setup again with a server to invite them.',
      );
      return 0;
    }
    const note = renderJoinNote({
      team: a.team.name,
      marketplace: values.marketplace,
      publicHost: a.hosting.publicHost,
    });
    ctx.stdout(
      [
        'Run these in Discord (admins only):',
        ...renderInviteLines(a),
        '',
        'Send your teammates:',
        note,
      ].join('\n'),
    );
    return 0;
  },
};
