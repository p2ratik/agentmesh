import { natsUsersFromConfig } from '@agentmesh/bus/permissions';
import {
  DEFAULT_MAX_FILE_STORE,
  type NatsConfigResult,
  renderNatsConfig,
} from '../render/nats-config';
import { loadTopology } from './config-files';
import { writeFileWithDirs } from './files';

/** Where deploy/docker-compose.yml mounts deploy/nats/tls inside the NATS container. */
export const DEFAULT_TLS_CERT = '/etc/nats/tls/fullchain.pem';
export const DEFAULT_TLS_KEY = '/etc/nats/tls/privkey.pem';

export interface TlsFiles {
  certFile: string;
  keyFile: string;
}

/**
 * Renders the NATS server config for the mesh at `configPath` and writes it to `out`.
 * `tls: true` uses the certificate paths docker compose mounts.
 */
export function writeNatsConfig(i: {
  configPath: string;
  env: Record<string, string | undefined>;
  out: string;
  tls: boolean | TlsFiles;
  callout: boolean;
  dev?: boolean;
  maxFileStore?: string;
  maxConnections?: number;
  allowMissing?: boolean;
}): NatsConfigResult {
  const { config } = loadTopology(i.configPath, i.env);
  const tls = i.tls === true ? { certFile: DEFAULT_TLS_CERT, keyFile: DEFAULT_TLS_KEY } : i.tls;
  const result = renderNatsConfig({
    meshName: config.mesh.name,
    prefix: config.mesh.prefix,
    users: natsUsersFromConfig(config),
    dev: i.dev ?? false,
    maxFileStore: i.maxFileStore ?? DEFAULT_MAX_FILE_STORE,
    ...(i.maxConnections !== undefined ? { maxConnections: i.maxConnections } : {}),
    allowMissing: i.allowMissing ?? false,
    ...(i.callout ? { authCallout: config.hub.authCallout ?? {} } : {}),
    ...(tls ? { tls } : {}),
  });
  writeFileWithDirs(i.out, result.text);
  return result;
}
