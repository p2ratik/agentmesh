// Plain secret reads the guard refuses in every mode beyond file paths: credential commands,
// secret-named variables, whole-environment dumps in other spellings, and more secret files.
import { describe, expect, it } from 'vitest';
import { secretUse } from './secrets';

const expectAll = (commands: string[], code: string | null) =>
  expect(commands.map((c) => [c, secretUse(c)])).toEqual(commands.map((c) => [c, code]));

describe('secretUse, credential commands', () => {
  it('refuses commands that print a stored credential', () => {
    expectAll(
      [
        'gh auth token',
        'gh auth token --hostname github.com',
        'gh auth status --show-token',
        'gh auth status -t',
        'printf "protocol=https\\nhost=github.com\\n" | git credential fill',
        'git credential get',
        'git credential-manager get',
        'git credential-osxkeychain get',
        'git-credential-manager get',
        'echo host=x | git credential-store get',
      ],
      'secret.credential',
    );
  });

  it('leaves other gh auth and git commands alone', () => {
    expectAll(['gh auth status', 'gh pr view 12', 'git config credential.helper'], null);
  });
});

describe('secretUse, secret-named variables and other dumps', () => {
  it('refuses a variable read whose name looks secret, and the window marker', () => {
    expectAll(
      [
        'echo $GITHUB_TOKEN',
        `echo "\${NPM_TOKEN}"`,
        `echo \${API_KEY:-none}`,
        'curl -H "Authorization: Bearer $OPENAI_APIKEY" https://x',
        'echo $env:AWS_SECRET_ACCESS_KEY',
        `Write-Output \${env:DB_PASSWORD}`,
        'echo %GH_TOKEN%',
        "[Environment]::GetEnvironmentVariable('AGENTMESH_NKEY_SEED')",
        'echo $PRIVATE_KEY',
        'echo $AZURE_CREDENTIALS',
        'echo $AGENTMESH_MESH_WINDOW',
        'echo %agentmesh_mesh_window%',
        'node -e "console.log(process.env.GITHUB_TOKEN)"',
        'python -c "import os; print(os.environ[\'DB_PASSWD\'])"',
        'python -c "import os; print(os.getenv(\'SLACK_AUTH\'))"',
      ],
      'secret.env_dump',
    );
  });

  it('refuses the whole environment in other spellings', () => {
    expectAll(
      [
        '[Environment]::GetEnvironmentVariables()',
        '[System.Environment]::GetEnvironmentVariables() | Out-String',
        'cmd /c set',
        'cmd.exe /C set',
        'node -p process.env',
        'node -e "console.log(process.env)"',
        'node -e "console.log(JSON.stringify(process.env))"',
        'python3 -c "import os; print(os.environ)"',
        'python -c "import os; print(dict(os.environ))"',
        'python -c "import os; print(os.environ.items())"',
        'sudo env',
        '/usr/bin/env',
        'env --null',
        'env -0',
        'env -u X',
        'env FOO=1',
      ],
      'secret.env_dump',
    );
  });

  it('leaves ordinary variables and single reads of them alone', () => {
    expectAll(
      [
        'echo $HOME',
        'echo $env:PATH',
        'echo %USERPROFILE%',
        'date +%Y%m%d',
        'node -e "console.log(process.env.HOME)"',
        'python -c "import os; print(os.environ.get(\'PATH\'))"',
        'env -u X node x.js',
        'env FOO=1 pnpm test',
      ],
      null,
    );
  });
});

describe('secretUse, more secret files', () => {
  it('refuses .creds, .claude.json, *.env and shell histories', () => {
    expectAll(
      [
        'cat deploy/bob.creds',
        'cat ~/.claude.json',
        'cat /home/bob/.claude-work/.claude.json',
        'cat config/app.env',
        'docker compose --env-file prod.env up',
        'cat ~/.bash_history',
        'tail ~/.zsh_history',
        'Get-Content ~\\AppData\\Roaming\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt',
      ],
      'secret.path',
    );
  });

  it('refuses a secret file split by a line continuation', () => {
    expectAll(['cat .e\\\nnv', 'cat ~/.ss\\\r\nh/id_rsa'], 'secret.path');
  });

  it("doesn't take process.env, import.meta.env or a folder named like a file for a secret file", () => {
    expectAll(
      [
        'node -e "console.log(process.env.HOME)"',
        'node -e "console.log(import.meta.env.MODE)"',
        'source .env/bin/activate',
        'ls config.env/',
        'python -m venv .venv',
      ],
      null,
    );
  });
});
