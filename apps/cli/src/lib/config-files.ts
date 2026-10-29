import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MeshError } from '@agentmesh/common';
import { type LoadedConfig, loadConfig } from '@agentmesh/config';

type Env = Record<string, string | undefined>;

/** Stands in for unset secrets; long enough for every secret's minimum length. */
export const SECRET_PLACEHOLDER = 'agentmesh-cli-placeholder-not-a-secret';

/** `mesh.yaml` (or `mesh.yml`) inside a directory, or the file itself. */
export function meshFilePath(path: string): string {
  if (existsSync(path) && statSync(path).isDirectory()) {
    for (const name of ['mesh.yaml', 'mesh.yml']) {
      const candidate = join(path, name);
      if (existsSync(candidate)) return candidate;
    }
    throw new MeshError('not_found', `No mesh.yaml in ${path} (pass --config <dir>)`);
  }
  if (!existsSync(path)) throw new MeshError('not_found', `Config not found: ${path}`);
  return path;
}

/**
 * `${NAME}` and `${NAME:-}` references in any YAML file under the config directory: those
 * with no real fallback (setup writes the Discord values as `${NAME:-}`).
 */
export function requiredEnvNames(configDir: string): string[] {
  const names = new Set<string>();
  const files = readdirSync(configDir, { recursive: true, encoding: 'utf8' }).filter(
    (f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.includes('node_modules'),
  );
  for (const file of files) {
    const text = readFileSync(join(configDir, file), 'utf8');
    for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-)?\}/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names].sort();
}

/** Required variables that are unset or empty in `env`. */
export function missingEnvNames(configDir: string, env: Env): string[] {
  return requiredEnvNames(configDir).filter((name) => !env[name]);
}

/**
 * Loads the config for commands that only need participants, keys and names
 * (nats-config, agent-setup). Unset secrets get a placeholder so an admin can
 * render NATS permissions without holding the Discord token or webhook secrets.
 */
export function loadTopology(configPath: string, env: Env): LoadedConfig {
  const file = meshFilePath(configPath);
  const filled: Env = { ...env };
  for (const name of missingEnvNames(dirname(file), env)) filled[name] = SECRET_PLACEHOLDER;
  return loadConfig(file, { env: filled });
}
