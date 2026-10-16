import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { STANDARD_PLANNING_TEMPLATE } from './defaults/planning';
import { DEFAULT_AGENT_POLICY } from './defaults/policy';
import { BUILTIN_WORKFLOWS } from './defaults/workflows';
import { interpolateEnv } from './env';
import { type MeshConfig, MeshConfigSchema } from './schema/mesh';
import { type ConfigIssue, validateReferences } from './validate';

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(file: string, issues: ConfigIssue[]) {
    const lines = issues.map((i) => `  - ${i.path || '(root)'}: ${i.message}`).join('\n');
    super(`Invalid mesh configuration in ${file}:\n${lines}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export interface LoadedConfig {
  config: MeshConfig;
  /** Absolute path of mesh.yaml. */
  file: string;
  /** Directory relative paths in the config resolve against. */
  dir: string;
  /** Full policy text agents receive (built-in etiquette + team policy). */
  policyText: string;
  /** Environment variables referenced without a value or fallback. */
  missingEnv: string[];
}

export interface LoadOptions {
  env?: Record<string, string | undefined>;
}

/** Loads `mesh.yaml` (or the file given) plus any workflow/rule files it includes. */
export function loadConfig(path: string, options: LoadOptions = {}): LoadedConfig {
  const file = resolveConfigFile(path);
  const dir = dirname(file);
  const { value: raw, missing } = interpolateEnv(readYaml(file), options.env);
  const tree = (raw ?? {}) as Record<string, unknown>;

  const include = (tree.include ?? {}) as { workflows?: string[]; rules?: string[] };
  const workflows = readDefinitions(dir, include.workflows ?? ['workflows'], 'workflows', options);
  const rules = readDefinitions(dir, include.rules ?? ['rules'], 'rules', options);
  const merged = {
    ...tree,
    workflows: [...workflows.definitions, ...asArray(tree.workflows)],
    rules: [...rules.definitions, ...asArray(tree.rules)],
  };
  const loaded = configFromObject(merged, { file, dir });
  const missingEnv = [...new Set([...missing, ...workflows.missing, ...rules.missing])].sort();
  return { ...loaded, missingEnv };
}

/**
 * Validates an already-parsed config tree (no file IO except a policy file).
 * Built-in workflows and the standard planning template are added unless
 * the tree defines ones with the same id. Used by `loadConfig` and by tests.
 */
export function configFromObject(
  tree: Record<string, unknown>,
  location: { file?: string; dir?: string } = {},
): LoadedConfig {
  const file = location.file ?? '(inline config)';
  const dir = location.dir ?? process.cwd();
  const userWorkflows = asArray(tree.workflows);
  const userIds = new Set(userWorkflows.map((w) => (w as { id?: string }).id));
  const planning = (tree.planning ?? {}) as { templates?: unknown[] };
  const templates = asArray(planning.templates);
  const hasStandard = templates.some(
    (t) => (t as { id?: string }).id === STANDARD_PLANNING_TEMPLATE.id,
  );

  const merged = {
    ...tree,
    workflows: [...BUILTIN_WORKFLOWS.filter((w) => !userIds.has(w.id)), ...userWorkflows],
    planning: {
      ...planning,
      templates: hasStandard ? templates : [STANDARD_PLANNING_TEMPLATE, ...templates],
    },
  };

  const parsed = MeshConfigSchema.safeParse(merged);
  if (!parsed.success) throw new ConfigError(file, zodIssues(parsed.error));
  const config = parsed.data;
  const issues = validateReferences(config);
  if (issues.length > 0) throw new ConfigError(file, issues);

  return { config, file, dir, policyText: buildPolicyText(config, dir), missingEnv: [] };
}

function resolveConfigFile(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute) && statSync(absolute).isDirectory()) {
    for (const name of ['mesh.yaml', 'mesh.yml']) {
      const candidate = join(absolute, name);
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`No mesh.yaml found in ${absolute}`);
  }
  if (!existsSync(absolute)) throw new Error(`Config file not found: ${absolute}`);
  return absolute;
}

function readYaml(file: string): unknown {
  try {
    return parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(file, [
      { path: '', message: `YAML parse error: ${(error as Error).message}` },
    ]);
  }
}

/** Every definition in the YAML files of the include folders, plus env names left unset. */
function readDefinitions(
  dir: string,
  folders: string[],
  key: string,
  options: LoadOptions,
): { definitions: unknown[]; missing: string[] } {
  const definitions: unknown[] = [];
  const missing: string[] = [];
  for (const file of folders.flatMap((folder) => yamlFilesIn(resolve(dir, folder)))) {
    const result = interpolateEnv(readYaml(file), options.env);
    definitions.push(...definitionsOf(result.value, key));
    missing.push(...result.missing);
  }
  return { definitions, missing };
}

function yamlFilesIn(folder: string): string[] {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => join(folder, f));
}

/** A definitions file may hold one object, a list, or `{ <key>: [...] }`. */
function definitionsOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && key in value) {
    return asArray((value as Record<string, unknown>)[key]);
  }
  return value ? [value] : [];
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function zodIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path
      .map((p) => (typeof p === 'number' ? `[${p}]` : String(p)))
      .join('.')
      .replace(/\.\[/g, '['),
    message: issue.message,
  }));
}

function buildPolicyText(config: MeshConfig, dir: string): string {
  const parts = [DEFAULT_AGENT_POLICY];
  if (config.policy.instructionsFile) {
    const policyFile = resolve(dir, config.policy.instructionsFile);
    if (!existsSync(policyFile)) {
      throw new ConfigError(policyFile, [
        { path: 'policy.instructionsFile', message: 'file not found' },
      ]);
    }
    parts.push(readFileSync(policyFile, 'utf8').trim());
  }
  if (config.policy.instructions) parts.push(config.policy.instructions.trim());
  return parts.join('\n\n');
}
