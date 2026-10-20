import {
  APP_ACCOUNT,
  type NatsUser,
  SYS_ACCOUNT,
  SYS_USER_PERMISSIONS,
} from '@agentmesh/bus/permissions';
import { MeshError } from '@agentmesh/common';
import { quote, renderNkeyUser, renderUser } from './nats-users';

/** Public keys from `hub.authCallout` in mesh.yaml; any may still be missing. */
export interface CalloutKeys {
  issuer?: string | undefined;
  xkey?: string | undefined;
  sysNkey?: string | undefined;
}

function requireKeys(keys: CalloutKeys, hubId: string): Required<CalloutKeys> {
  const missing = [
    keys.issuer ? null : `${hubId}-issuer`,
    keys.xkey ? null : `${hubId}-xkey`,
    keys.sysNkey ? null : `${hubId}-sys`,
  ].filter((id): id is string => id !== null);
  if (missing.length > 0 || !keys.issuer || !keys.xkey || !keys.sysNkey) {
    throw new MeshError(
      'invalid_request',
      `--auth-callout needs hub.authCallout keys. Run \`agentmesh keys add <id>\` for: ${missing.join(', ')}.`,
    );
  }
  return { issuer: keys.issuer, xkey: keys.xkey, sysNkey: keys.sysNkey };
}

/**
 * The account-mode auth section (docs/specs/auth-callout-spike.md). The hub and
 * every service stay static users with their own permissions, so the hub can
 * never lock itself out; agents are admitted only by the hub's callout, which
 * fails closed when the hub is down.
 */
export function renderCalloutAuth(
  staticUsers: Array<NatsUser & { nkey: string }>,
  prefix: string,
  keys: CalloutKeys,
): string[] {
  const hub = staticUsers.find((u) => u.kind === 'hub');
  if (!hub) {
    throw new MeshError('invalid_request', '--auth-callout needs the hub nkey (`keys add hub`).');
  }
  const { issuer, xkey, sysNkey } = requireKeys(keys, hub.id);
  const authUsers = [...staticUsers.map((u) => u.nkey), sysNkey];
  return [
    '',
    '# Agents are not listed here: the hub admits each one through the auth callout.',
    'accounts {',
    `  ${APP_ACCOUNT} {`,
    '    jetstream: enabled',
    '    users: [',
    staticUsers.map((u) => renderUser(u, prefix, '      ')).join(',\n'),
    '    ]',
    '  }',
    `  ${SYS_ACCOUNT} {`,
    '    users: [',
    renderNkeyUser(`${hub.id} system user (kick only)`, sysNkey, SYS_USER_PERMISSIONS, '      '),
    '    ]',
    '  }',
    '}',
    `system_account: ${SYS_ACCOUNT}`,
    '',
    'authorization {',
    '  auth_callout {',
    `    issuer: ${quote(issuer)}`,
    `    account: ${APP_ACCOUNT}`,
    '    # Static users bypass the callout.',
    `    auth_users: [${authUsers.map(quote).join(', ')}]`,
    '    # Seals auth requests, so invite codes never cross the bus in the clear.',
    `    xkey: ${quote(xkey)}`,
    '  }',
    '}',
  ];
}
