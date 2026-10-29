import { parseCommandArgs } from '../../args';
import type { Command } from '../../context';
import { runProcess } from '../../lib/process';
import { checkDns, lookupAddresses } from '../../setup/checks/dns';
import { runChecked, SSH_OPTIONS, sshProgram, sshUser } from '../../setup/remote';
import { renderHostScript } from '../../setup/render/host-script';
import { loadAnswers, markDone, workspaceFrom } from '../../setup/workspace';

export const setupHostCommand: Command = {
  name: 'setup host',
  summary: 'Prepare the server over SSH: Docker, the TLS certificate and its renewal',
  help: `Usage: agentmesh setup host --dir <workspace>

Checks that hosting.publicHost resolves, then pipes a script to \`sudo bash -s\` on the
server over ssh (hosting.ssh, with your own SSH key). The script installs Docker and
certbot, creates hosting.remoteDir owned by the ssh user, gets a Let's Encrypt
certificate for NATS TLS and installs the hook that renews it. Ubuntu 24.04 is the
tested target. Safe to re-run. On a trial there is nothing to do.`,
  async run(argv, ctx) {
    const { values } = parseCommandArgs(
      argv,
      { dir: { type: 'string' } },
      { min: 0, max: 0, names: '' },
    );
    const p = workspaceFrom(ctx, values.dir);
    const { hosting } = loadAnswers(p);
    // Not marked done: status and deploy skip host on a trial, and a trial going real needs it.
    if (hosting.mode === 'trial') {
      ctx.stdout('Nothing to do on a trial.');
      return 0;
    }

    const dns = await checkDns(hosting.publicHost, ctx.lookup ?? lookupAddresses);
    if (!dns.ok) {
      ctx.stderr(
        `DNS for ${hosting.publicHost} does not resolve yet. Point an A record at the server, ` +
          'wait a minute, and run again.',
      );
      return 1;
    }
    ctx.stdout(dns.label);
    const script = renderHostScript({
      publicHost: hosting.publicHost,
      remoteDir: hosting.remoteDir,
      user: sshUser(hosting.ssh),
    });
    await runChecked(
      ctx.run ?? runProcess,
      sshProgram('ssh', ctx),
      [...SSH_OPTIONS, '--', hosting.ssh, 'sudo bash -s'],
      { input: script },
      'Preparing the server',
    );
    markDone(p, 'host', new Date());
    ctx.stdout(`Server ready: Docker and a TLS certificate for ${hosting.publicHost}.`);
    return 0;
  },
};
