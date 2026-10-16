import type { KeyHolder } from '../lib/mesh-document';

export interface KeyRow {
  holder: KeyHolder;
  seedFound: boolean;
}

const shortKey = (key: string): string => `${key.slice(0, 6)}…${key.slice(-4)}`;
const kindLabel = (h: KeyHolder): string => (h.kind === 'service' ? `service/${h.role}` : h.kind);

/** A table of who has a public key in mesh.yaml and whether a seed is in the secrets dir. */
export function renderKeyTable(rows: KeyRow[], secretsDir: string): string {
  const width = Math.max(11, ...rows.map((r) => r.holder.id.length)) + 2;
  const header = `${'PARTICIPANT'.padEnd(width)}${'KIND'.padEnd(16)}${'PUBLIC KEY'.padEnd(14)}SEED`;
  const lines = rows.map(({ holder, seedFound }) =>
    [
      holder.id.padEnd(width),
      kindLabel(holder).padEnd(16),
      (holder.nkey ? shortKey(holder.nkey) : 'missing').padEnd(14),
      seedFound ? 'present' : '-',
    ].join(''),
  );
  const missing = rows.filter((r) => !r.holder.nkey).length;
  const footer =
    missing > 0
      ? `${missing} without a key: run \`agentmesh keys add <id>\`.`
      : 'Every participant has a key.';
  return [header, ...lines, '', `Seeds looked up in ${secretsDir}. ${footer}`].join('\n');
}

export interface KeyAddedInput {
  holder: KeyHolder;
  publicKey: string;
  seedFile: string;
  meshFile: string;
}

/** What to do with a freshly generated seed, depending on who holds it. */
export function renderKeyAdded(input: KeyAddedInput): string {
  const { holder } = input;
  const who =
    holder.kind === 'agent'
      ? [
          `Send ${input.seedFile} to ${holder.id}'s owner over a private channel. They save it as`,
          `~/.agentmesh/${holder.id}.nk and run \`agentmesh agent-setup ${holder.id}\`.`,
        ]
      : [
          'Keep the seed on the hub VM: docker compose mounts deploy/secrets read-only and the',
          `container reads /secrets/${holder.id}.nk.`,
        ];
  return [
    `Generated an nkey for ${kindLabel(holder)} ${holder.id}`,
    `  public key  ${input.publicKey}  -> ${input.meshFile} (${holder.path})`,
    `  seed        ${input.seedFile} (private, mode 600)`,
    '',
    'Next:',
    ...who.map((l) => `  ${l}`),
    '  Never commit seed files; *.nk is git-ignored.',
    '  Regenerate the NATS config: `agentmesh nats-config`, then reload NATS.',
  ].join('\n');
}
