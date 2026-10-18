import { type NatsUser, type Permissions, permissionsFor } from '@agentmesh/bus/permissions';

/** NATS config strings are double-quoted so `$JS…` is never read as a variable. */
export const quote = (value: string): string => JSON.stringify(value);

export function list(values: string[], indent: string): string {
  return `[\n${values.map((v) => `${indent}  ${quote(v)}`).join(',\n')}\n${indent}]`;
}

/** One `{ nkey, permissions }` entry of a `users` list, indented by `indent`. */
export function renderNkeyUser(
  label: string,
  nkey: string,
  perms: Permissions,
  indent: string,
): string {
  const inner = `${indent}    `;
  return [
    `${indent}# ${label}`,
    `${indent}{`,
    `${indent}  nkey: ${quote(nkey)}`,
    `${indent}  permissions: {`,
    `${inner}publish: { allow: ${list(perms.publish, inner)} }`,
    `${inner}subscribe: { allow: ${list(perms.subscribe, inner)} }`,
    `${indent}  }`,
    `${indent}}`,
  ].join('\n');
}

/** A participant with least-privilege permissions from `permissionsFor`. */
export function renderUser(
  user: NatsUser & { nkey: string },
  prefix: string,
  indent = '    ',
): string {
  const label = user.kind === 'hub' ? 'hub' : `${user.kind} ${user.id}`;
  return renderNkeyUser(label, user.nkey, permissionsFor(user, prefix), indent);
}
