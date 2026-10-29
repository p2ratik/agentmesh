import { MeshError } from '@agentmesh/common';
import { parseCommandArgs } from '../args';
import { type Command, configPathFrom, resolveFrom } from '../context';
import {
  DEFAULT_TLS_CERT,
  DEFAULT_TLS_KEY,
  type TlsFiles,
  writeNatsConfig,
} from '../lib/nats-config-file';

const OPTIONS = {
  config: { type: 'string' },
  out: { type: 'string' },
  dev: { type: 'boolean' },
  tls: { type: 'boolean' },
  'tls-cert': { type: 'string' },
  'tls-key': { type: 'string' },
  'max-file-store': { type: 'string' },
  'max-connections': { type: 'string' },
  'allow-missing': { type: 'boolean' },
  'auth-callout': { type: 'boolean' },
} as const;

/** --tls, or either path flag alone, turns TLS on; paths default to the compose mounts. */
function tlsFrom(values: {
  tls?: boolean | undefined;
  'tls-cert'?: string | undefined;
  'tls-key'?: string | undefined;
}): TlsFiles | undefined {
  if (!values.tls && values['tls-cert'] === undefined && values['tls-key'] === undefined) {
    return undefined;
  }
  return {
    certFile: values['tls-cert'] ?? DEFAULT_TLS_CERT,
    keyFile: values['tls-key'] ?? DEFAULT_TLS_KEY,
  };
}

export const natsConfigCommand: Command = {
  name: 'nats-config',
  summary: 'Render nats-server.conf with least-privilege users for every participant',
  help: `Usage: agentmesh nats-config [--config <dir>] [--out <file>] [--dev]
                             [--tls [--tls-cert <path>] [--tls-key <path>]]
                             [--max-file-store 5GB] [--max-connections 1024]
                             [--allow-missing] [--auth-callout]

Writes a NATS server config (default: deploy/nats/nats.conf) where each agent
can only publish RPCs as itself and read its own inbox. --tls requires TLS for
every client (use it whenever NATS is reachable from the internet); paths
default to the certificate files docker compose mounts at /etc/nats/tls.
--auth-callout renders account mode: the hub and services stay static users and
the hub admits agents itself (needs hub.authCallout keys: keys add hub-issuer,
hub-xkey, hub-sys). --max-connections caps client connections in all (one per
Claude Code session). --dev renders a config without authentication for local
development.`,
  run(argv, ctx) {
    const { values } = parseCommandArgs(argv, OPTIONS, { min: 0, max: 0, names: '' });
    const tls = tlsFrom(values);
    const callout = values['auth-callout'] ?? false;
    if (values.dev && (tls || callout)) {
      throw new MeshError(
        'invalid_request',
        '--dev cannot be combined with --tls or --auth-callout',
      );
    }
    const out = resolveFrom(ctx, values.out ?? 'deploy/nats/nats.conf');
    const result = writeNatsConfig({
      configPath: configPathFrom(ctx, values.config),
      env: ctx.env,
      out,
      tls: tls ?? false,
      callout,
      dev: values.dev ?? false,
      ...(values['max-file-store'] !== undefined ? { maxFileStore: values['max-file-store'] } : {}),
      ...(values['max-connections'] !== undefined
        ? { maxConnections: Number(values['max-connections']) }
        : {}),
      allowMissing: values['allow-missing'] ?? false,
    });
    const notes = [
      tls ? ' (TLS required)' : '',
      callout ? '; agents join via the hub callout' : '',
    ];
    ctx.stdout(
      values.dev
        ? `Wrote ${out} (DEV MODE: no authentication).`
        : `Wrote ${out} with ${result.included.length} users: ${result.included.join(', ')}${notes.join('')}.`,
    );
    if (result.skipped.length > 0) {
      ctx.stderr(`warning: left out (no nkey yet): ${result.skipped.join(', ')}`);
    }
    return 0;
  },
};
