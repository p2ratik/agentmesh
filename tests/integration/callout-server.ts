import { type ChildProcess, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { natsUsersFromConfig } from '@agentmesh/bus';
import { renderNatsConfig } from '../../apps/cli/src/render/nats-config';
import type { HubOptions } from '../../apps/hub/src/app';

export interface CalloutServerOptions {
  bin: string;
  loaded: HubOptions['loaded'];
  dir: string;
  port: number;
  /** Serves the monitoring endpoints (`/connz`) on this port; off by default. */
  monitorPort?: number;
}

/**
 * Starts nats-server in account mode with the hub's auth callout, from the
 * nats.conf the CLI renders (`nats-config --auth-callout`), on test ports.
 */
export function startCalloutNats(options: CalloutServerOptions): ChildProcess {
  const { config } = options.loaded;
  const monitor = options.monitorPort ? `http: "127.0.0.1:${options.monitorPort}"` : '';
  const conf = renderNatsConfig({
    meshName: config.mesh.name,
    prefix: config.mesh.prefix,
    users: natsUsersFromConfig(config),
    dev: false,
    maxFileStore: '256MB',
    allowMissing: true,
    authCallout: config.hub.authCallout ?? {},
  })
    .text.replace('port: 4222', `port: ${options.port}`)
    .replace('http: "127.0.0.1:8222"', monitor)
    .replace('"/data/jetstream"', JSON.stringify(join(options.dir, 'js')));
  const file = join(options.dir, 'nats.conf');
  writeFileSync(file, conf);
  return spawn(options.bin, ['-c', file, '-a', '127.0.0.1'], { stdio: 'ignore' });
}
