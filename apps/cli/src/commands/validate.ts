import { ConfigError, loadConfig } from '@agentmesh/config';
import { parseCommandArgs } from '../args';
import { type Command, configPathFrom } from '../context';
import { meshFilePath } from '../lib/config-files';
import { renderIssues, renderMissingEnv, renderSummary } from '../render/validate-report';

export const validateCommand: Command = {
  name: 'validate',
  summary: 'Check mesh.yaml, workflows and rules; print what the hub will run with',
  help: `Usage: agentmesh validate [--config <dir>]

Loads the config exactly like the hub (with your current environment) and
reports every problem with its path. Exit code 1 when the config is invalid.`,
  run(argv, ctx) {
    const { values } = parseCommandArgs(
      argv,
      { config: { type: 'string' } },
      { min: 0, max: 0, names: '' },
    );
    const file = meshFilePath(configPathFrom(ctx, values.config));
    try {
      const loaded = loadConfig(file, { env: ctx.env });
      ctx.stdout(renderSummary(loaded));
      if (loaded.missingEnv.length > 0) ctx.stderr(renderMissingEnv(loaded.missingEnv));
      return 0;
    } catch (error) {
      if (error instanceof ConfigError) {
        ctx.stderr(renderIssues(file, error.issues));
        return 1;
      }
      throw error;
    }
  },
};
