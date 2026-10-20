import { type ConfigIssue, type LoadedConfig, pendingAreaOwners } from '@agentmesh/config';

const ids = (items: ReadonlyArray<{ id: string }>): string =>
  items.length === 0 ? '0' : `${items.length} (${items.map((i) => i.id).join(', ')})`;

const row = (label: string, value: string): string => `  ${`${label}:`.padEnd(12)} ${value}`;

/** One line per issue, each with its config path. */
export function renderIssues(file: string, issues: ConfigIssue[]): string {
  const lines = issues.map((i) => `  ${i.path || '(root)'}: ${i.message}`);
  const noun = issues.length === 1 ? 'problem' : 'problems';
  return [`${file}: ${issues.length} ${noun}`, ...lines].join('\n');
}

export function renderMissingEnv(names: string[]): string {
  return (
    `warning: environment variables without a value or fallback: ${names.join(', ')}\n` +
    '         (they become empty strings; set them in your shell or deploy/.env)'
  );
}

/** What the hub will run with, so a typo (a missing agent, a disabled rule) is visible. */
export function renderSummary(loaded: LoadedConfig): string {
  const { config } = loaded;
  const enabledRules = config.rules.filter((r) => r.enabled).length;
  const { planning, discord } = config;
  const pending = pendingAreaOwners(config);
  return [
    `OK ${loaded.file}`,
    row('Mesh', `${config.mesh.name} (prefix "${config.mesh.prefix}")`),
    row('Humans', ids(config.humans)),
    row('Agents', ids(config.agents)),
    row('Services', ids(config.services)),
    row('Areas', ids(config.areas)),
    ...(pending.length > 0
      ? [
          row(
            'Pending',
            `${pending.join(', ')} (area owners not in mesh.yaml: they join by invite)`,
          ),
        ]
      : []),
    row('Workflows', ids(config.workflows)),
    row('Rules', `${config.rules.length} (${enabledRules} enabled)`),
    row('Ingest', ids(config.ingest.sources)),
    row(
      'Planning',
      `facilitator ${planning.facilitator}, ` +
        `${planning.requireApproval ? 'human approval required' : 'no approval step'}, ` +
        `templates ${planning.templates.map((t) => t.id).join(', ')}`,
    ),
    row('Discord', discord.enabled ? `enabled (service ${discord.serviceId})` : 'disabled'),
  ].join('\n');
}
