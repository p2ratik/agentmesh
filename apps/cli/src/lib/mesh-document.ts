import { MeshError } from '@agentmesh/common';
import { type Document, isMap, isSeq, parseDocument } from 'yaml';

/** Who can hold a NATS nkey: agents, services, and the hub's own user. */
export type KeyHolderKind = 'agent' | 'service' | 'hub';

export interface KeyHolder {
  id: string;
  kind: KeyHolderKind;
  /** Service role (`bridge`, `ingest`, `custom`); absent for agents and the hub. */
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

/** Every participant that can hold a key, read straight from the YAML (no env needed). */
export function listKeyHolders(text: string): KeyHolder[] {
  const doc = parse(text);
  const holders: KeyHolder[] = [];
  const hubId = stringOrNull(doc.getIn(['hub', 'serviceId'])) ?? 'hub';
  holders.push({
    id: hubId,
    kind: 'hub',
    nkey: stringOrNull(doc.getIn(['hub', 'nkey'])),
    path: 'hub.nkey',
    yamlPath: ['hub', 'nkey'],
  });
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

/** Finds a key holder or explains why the id cannot hold a key. */
export function findKeyHolder(text: string, participantId: string): KeyHolder {
  const holders = listKeyHolders(text);
  const holder = holders.find((h) => h.id === participantId);
  if (holder) return holder;
  if (listEntries(parse(text), 'humans').some((h) => h.id === participantId)) {
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
