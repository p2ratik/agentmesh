// The window's permission mode (auto by default, or manual) and the secret paths its settings deny
// in every mode.
import { CHANNEL_FLAG, LAUNCH_PROMPT, windowFiles } from '@agentmesh/common/window';
import { describe, expect, it } from 'vitest';
import { launcherScript, secretReadRules, windowSettings } from './window';

const inputs = (mode: 'auto' | 'manual', configDir: string | null = null) => ({
  agentId: 'bob-agent',
  claude: '/usr/bin/claude',
  files: windowFiles('/home/bob', 'linux'),
  token: '0123456789abcdef0123456789abcdef',
  testCommands: ['pnpm check'],
  ownBranchPrefix: 'agent/bob/',
  integrationBranch: 'agents',
  mode,
  configDir,
});

type Permissions = Record<string, unknown> & { allow: string[]; deny: string[] };
const permissions = (i: ReturnType<typeof inputs>) => windowSettings(i).permissions as Permissions;

/** The deny list the settings carry, spelled out once here. */
const DENY = [
  'Read(//**/.env)',
  'Read(//**/.env.*)',
  'Read(//**/*.env)',
  'Read(//**/*.pem)',
  'Read(//**/*.key)',
  'Read(//**/*.p12)',
  'Read(//**/*.pfx)',
  'Read(//**/*.nk)',
  'Read(//**/*.creds)',
  'Read(//**/id_rsa*)',
  'Read(//**/id_ed25519*)',
  'Read(//**/id_ecdsa*)',
  'Read(//**/id_dsa*)',
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.azure/**)',
  'Read(~/.config/gcloud/**)',
  'Read(~/.config/gh/**)',
  'Read(~/.kube/**)',
  'Read(~/.docker/config.json)',
  'Read(~/.gnupg/**)',
  'Read(~/.netrc)',
  'Read(~/.git-credentials)',
  'Read(~/.npmrc)',
  'Read(~/.pypirc)',
  'Read(~/.bash_history)',
  'Read(~/.zsh_history)',
  'Read(~/AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt)',
  'Read(~/.agentmesh/**)',
  'Read(~/.claude/.credentials.json)',
  'Read(~/.claude.json)',
  'Read(~/AppData/Local/Google/Chrome/**)',
  'Read(~/AppData/Local/Microsoft/Edge/**)',
  'Read(~/AppData/Roaming/Mozilla/**)',
  'Read(~/Library/Application Support/Google/Chrome/**)',
  'Read(~/Library/Application Support/Firefox/**)',
  'Read(~/.mozilla/**)',
  'Read(~/.config/google-chrome/**)',
  'Read(~/.config/chromium/**)',
];

describe('the window in auto mode (the default)', () => {
  it('starts in auto mode, refuses bypass, and leaves auto in the Shift+Tab cycle', () => {
    const p = permissions(inputs('auto'));
    expect(p.defaultMode).toBe('auto');
    expect(p.disableBypassPermissionsMode).toBe('disable');
    expect('disableAutoMode' in p).toBe(false);
    expect(launcherScript(inputs('auto'), 'linux').split('\n')[4]).toBe(
      `exec '/usr/bin/claude' ${CHANNEL_FLAG} -n 'mesh-bob-agent' --permission-mode auto --settings '/home/bob/.agentmesh/mesh-window.settings.json' '${LAUNCH_PROMPT}'`,
    );
    const win = { ...inputs('auto'), claude: 'C:\\c.cmd', files: windowFiles('C:\\h', 'win32') };
    expect(launcherScript(win, 'win32')).toContain(' --permission-mode auto --settings ');
  });

  it('keeps the same allow rules as manual mode', () => {
    expect(permissions(inputs('auto')).allow).toEqual(permissions(inputs('manual')).allow);
  });
});

describe('the window in manual mode', () => {
  it('starts in default mode and keeps auto and bypass out of reach', () => {
    const p = permissions(inputs('manual'));
    expect(p.defaultMode).toBe('default');
    expect(p.disableBypassPermissionsMode).toBe('disable');
    expect(p.disableAutoMode).toBe('disable');
    expect(launcherScript(inputs('manual'), 'linux')).toContain(
      ' --permission-mode default --settings ',
    );
  });
});

describe('the secret deny list', () => {
  it('denies reads of every secret path, in both modes', () => {
    for (const mode of ['auto', 'manual'] as const) {
      expect(permissions(inputs(mode)).deny).toEqual(DENY);
    }
    expect(secretReadRules(null)).toEqual(DENY);
  });

  it("adds the window account's own credentials and .claude.json as absolute POSIX paths", () => {
    expect(secretReadRules('/home/bob/.claude-work')).toEqual([
      ...DENY,
      'Read(//home/bob/.claude-work/.credentials.json)',
      'Read(//home/bob/.claude-work/.claude.json)',
    ]);
    expect(secretReadRules('C:\\Users\\bob\\.claude-work\\')).toEqual([
      ...DENY,
      'Read(//c/Users/bob/.claude-work/.credentials.json)',
      'Read(//c/Users/bob/.claude-work/.claude.json)',
    ]);
    expect(permissions(inputs('auto', '/home/bob/.cw')).deny.slice(-2)).toEqual([
      'Read(//home/bob/.cw/.credentials.json)',
      'Read(//home/bob/.cw/.claude.json)',
    ]);
  });
});
