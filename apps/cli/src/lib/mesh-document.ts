import { MeshError } from '@agentmesh/common';
import { type Document, isMap, isSeq, parseDocument } from 'yaml';

/** Who can hold a NATS nkey: agents, services, the hub's own user and its auth-callout keys. */
export type KeyHolderKind = 'agent' | 'service' | 'hub' | 'callout';

/** The hub's auth-callout keys: the JWT issuer account, the xkey curve and the sys user. */
export type CalloutKeyRole = 'issuer' | 'xkey' | 'sys';

const CALLOUT_FIELDS: Record<CalloutKeyRole, string> = {
  issuer: 'issuer',
  xkey: 'xkey',
  sys: 'sysNkey',
};

export interface KeyHolder {
  id: string;
  kind: KeyHolderKind;
  /** Service role (`bridge`, `ingest`, `custom`) or callout key role; absent for agents and the hub. */
  role?: string;
  nkey: string | null;
  /** Where the public key lives in mesh.yaml, e.g. `agents[2].nkey`. */
  path: string;
  yamlPath: Array<string | number>;
}

// Emit flow collections as `[a, b]`, and never re-fold long lines.
const TO_STRING = { lineWidth: 0, flowCollectionPadding: false } as const;

function parse(text: string): Document {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new MeshError(
      'invalid_request',
      `mesh.yaml is not valid YAML: ${doc.errors[0]?.message}`,
    );
  }
  return doc;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function listEntries(doc: Document, section: 'agents' | 'services' | 'humans') {
  const node = doc.get(section, true);
  if (!isSeq(node)) return [];
  return node.items.flatMap((item, index) => {
    if (!isMap(item)) return [];
    const id = stringOrNull(item.get('id'));
    return id ? [{ id, index, nkey: stringOrNull(item.get('nkey')), role: item.get('role') }] : [];
  });
}

/** `<hub>-issuer`, `<hub>-xkey` and `<hub>-sys`, whether or not they have keys yet. */
function calloutHolders(doc: Document, hubId: string): KeyHolder[] {
  return (Object.keys(CALLOUT_FIELDS) as CalloutKeyRole[]).map((role) => {
    const field = CALLOUT_FIELDS[role];
    return {
      id: `${hubId}-${role}`,
      kind: 'callout',
      role,
      nkey: stringOrNull(doc.getIn(['hub', 'authCallout', field])),
      path: `hub.authCallout.${field}`,
      yamlPath: ['hub', 'authCallout', field],
    };
  });
}

function keyHolders(doc: Document, withCallout: boolean): KeyHolder[] {
  const holders: KeyHolder[] = [];
  const hubId = stringOrNull(doc.getIn(['hub', 'serviceId'])) ?? 'hub';
  holders.push({
    id: hubId,
    kind: 'hub',
    nkey: stringOrNull(doc.getIn(['hub', 'nkey'])),
    path: 'hub.nkey',
    yamlPath: ['hub', 'nkey'],
  });
  if (withCallout || isMap(doc.getIn(['hub', 'authCallout'], true))) {
    holders.push(...calloutHolders(doc, hubId));
  }
  for (const a of listEntries(doc, 'agents')) {
    const path = `agents[${a.index}].nkey`;
    holders.push({
      id: a.id,
      kind: 'agent',
      nkey: a.nkey,
      path,
      yamlPath: ['agents', a.index, 'nkey'],
    });
  }
  for (const s of listEntries(doc, 'services')) {
    holders.push({
      id: s.id,
      kind: 'service',
      ...(typeof s.role === 'string' ? { role: s.role } : {}),
      nkey: s.nkey,
      path: `services[${s.index}].nkey`,
      yamlPath: ['services', s.index, 'nkey'],
    });
  }
  return holders;
}

/**
 * Every participant that can hold a key, read straight from the YAML (no env
 * needed). The hub's callout keys are listed once `hub.authCallout` exists.
 */
export function listKeyHolders(text: string): KeyHolder[] {
  return keyHolders(parse(text), false);
}

/** Finds a key holder or explains why the id cannot hold a key. */
export function findKeyHolder(text: string, participantId: string): KeyHolder {
  const doc = parse(text);
  const holders = keyHolders(doc, true);
  const holder = holders.find((h) => h.id === participantId);
  if (holder) return holder;
  if (listEntries(doc, 'humans').some((h) => h.id === participantId)) {
    throw new MeshError(
      'invalid_request',
      `"${participantId}" is a human. Humans act through the Discord bridge; give a key to their agent instead.`,
    );
  }
  const known = holders.map((h) => h.id).join(', ');
  throw new MeshError('not_found', `No agent, service or hub "${participantId}". Known: ${known}`);
}

/**
 * Writes a public key into mesh.yaml through the YAML document model, so
 * comments, ordering and env placeholders survive. Returns the new text.
 */
export function setPublicKey(text: string, participantId: string, publicKey: string): string {
  const holder = findKeyHolder(text, participantId);
  const doc = parse(text);
  doc.setIn(holder.yamlPath, publicKey);
  return doc.toString(TO_STRING);
}

function humanPath(doc: Document, humanId: string): Array<string | number> | null {
  const human = listEntries(doc, 'humans').find((h) => h.id === humanId);
  return human ? ['humans', human.index, 'discordUserId'] : null;
}

/** A human's `discordUserId` in mesh.yaml, or null when it is not set. */
export function humanDiscordId(text: string, humanId: string): string | null {
  const doc = parse(text);
  const path = humanPath(doc, humanId);
  return path ? stringOrNull(doc.getIn(path)) : null;
}

/** Writes a human's `discordUserId` into mesh.yaml, keeping comments. Returns the new text. */
export function setHumanDiscordId(text: string, humanId: string, discordUserId: string): string {
  const doc = parse(text);
  const path = humanPath(doc, humanId);
  if (!path) throw new MeshError('not_found', `No human "${humanId}" in mesh.yaml`);
  doc.setIn(path, discordUserId);
  return doc.toString(TO_STRING);
}
