// Built-ins only (no imports at all): the plugin's guard bundle imports this, and so does the CLI
// that renders the mesh window's settings. The secret paths, defined once: the window's settings
// deny reads of each one (`Read(...)` rules), and the guard denies a command that names one.

/** Secret file names, anywhere (a deny rule spells each `//**` + `/<name>`). */
export const SECRET_NAMES = [
  '.env',
  '.env.*',
  '*.env',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.nk',
  '*.creds',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  'id_dsa*',
] as const;

/** Credential stores, shell histories, Claude's account files and browser profiles below the home
 * folder (a deny rule spells `~/<path>`). */
export const SECRET_HOME_PATHS = [
  '.ssh/**',
  '.aws/**',
  '.azure/**',
  '.config/gcloud/**',
  '.config/gh/**',
  '.kube/**',
  '.docker/config.json',
  '.gnupg/**',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.bash_history',
  '.zsh_history',
  'AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt',
  '.agentmesh/**',
  '.claude/.credentials.json',
  '.claude.json',
  'AppData/Local/Google/Chrome/**',
  'AppData/Local/Microsoft/Edge/**',
  'AppData/Roaming/Mozilla/**',
  'Library/Application Support/Google/Chrome/**',
  'Library/Application Support/Firefox/**',
  '.mozilla/**',
  '.config/google-chrome/**',
  '.config/chromium/**',
] as const;

/** A Claude account's own files, in its config folder (`CLAUDE_CONFIG_DIR` when set). */
export const CLAUDE_ACCOUNT_FILES = ['.credentials.json', '.claude.json'] as const;
