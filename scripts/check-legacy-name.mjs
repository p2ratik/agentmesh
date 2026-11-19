#!/usr/bin/env node
// Keeps the old product name (AgentMesh) out of the repository, except in the few files that
// need it on purpose. Usage: node scripts/check-legacy-name.mjs [root]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? '.';
const OLD_NAME = /agentmesh/i;
// Local checkout paths (G:\Projects\AgentMesh-relay, ...) keep the old name; they are not product text.
const PROTECTED_PATH = /Projects[-\\/]+AgentMesh[A-Za-z-]*/g;
const DIST = 'plugins/cmw/dist/';

// Files that may hold the old name, each for one reason. Every path must exist and still hold
// a hit, so the list cannot rot.
const ALLOWED = [
  // The folder fallback: ~/.agentmesh moves to ~/.cosmicwave, and is used in place until it can.
  'packages/common/src/mesh-home.ts',
  'packages/common/src/mesh-home.test.ts',
  'packages/common/src/window.ts',
  'packages/common/src/agent-files.test.ts',
  'apps/cli/src/main.ts',
  'apps/cli/src/commands/agent-setup.ts',
  'apps/cli/src/commands/window.ts',
  'apps/cli/src/commands/window.test.ts',
  'apps/cli/src/cli.test.ts',
  'plugins/cmw/src/main.ts',
  'plugins/cmw/src/config.ts',
  'plugins/cmw/src/config.test.ts',
  'plugins/cmw/src/agent-id.test.ts',
  'plugins/cmw/src/pull/state.ts',
  'plugins/cmw/src/pull/state.test.ts',
  'plugins/cmw/src/telemetry/events-file.test.ts',
  'plugins/cmw/src/window/guard-stamp.test.ts',
  'plugins/cmw/src/hook.entry.test.ts',
  'tests/integration/support.ts',
  // The secret deny list and the guard: the old folder stays off limits.
  'packages/common/src/secret-paths.ts',
  'plugins/cmw/src/guard/paths.ts',
  'plugins/cmw/src/guard/paths.test.ts',
  'plugins/cmw/src/guard/paths.fixture.ts',
  'plugins/cmw/src/guard/secrets.test.ts',
  'plugins/cmw/src/guard/decide.test.ts',
  // The reason code path.agentmesh_dir, kept so stored events and viewers still match.
  'packages/protocol/src/observe-codes.ts',
  // The shim marker: how a window set up before the rename is recognised and told to set up again.
  'apps/cli/src/render/window.ts',
  'apps/cli/src/render/window-modes.test.ts',
  'apps/cli/src/commands/window-shim.test.ts',
  'plugins/cmw/src/window/session-start.ts',
  'plugins/cmw/src/window/session-start.test.ts',
  // The Discord names: webhooks made under the old name are still found and reused.
  'apps/discord-bridge/src/discord/webhooks.ts',
  'apps/discord-bridge/src/discord/webhooks.test.ts',
  // The volume guard: a server whose data sits in agentmesh_* volumes keeps its compose project.
  'apps/cli/src/setup/deploy.ts',
  'apps/cli/src/commands/setup/deploy.test.ts',
  'tests/deploy/volume-guard.test.ts',
  // The workspace conversion: a workspace made as AgentMesh is converted in place.
  'apps/cli/src/setup/legacy-workspace.ts',
  'apps/cli/src/setup/legacy-workspace.test.ts',
  // The server installers and host script, with their tests and fixtures.
  'deploy/legacy-names.sh',
  'deploy/auto-deploy/cosmicwave-deploy.sh',
  'deploy/auto-deploy/install.sh',
  'deploy/backup/install.sh',
  'apps/cli/src/setup/render/host-script.ts',
  'apps/cli/src/setup/render/host-hardening.ts',
  'apps/cli/src/setup/render/host-hardening.test.ts',
  'tests/deploy/legacy-installers.test.ts',
  'tests/deploy/legacy-names.test.ts',
  // The name check itself and its test.
  'scripts/check-legacy-name.mjs',
  'tests/repo/legacy-name.test.ts',
  // The two rename documents.
  'docs/specs/2026-11-19-cosmicwave-rename-design.md',
  'docs/specs/2026-11-19-cosmicwave-rename-plan.md',
  // The "moving from AgentMesh" section of the security doc.
  'docs/security.md',
];

const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .map((f) => f.replaceAll('\\', '/'));

const utf8 = new TextDecoder('utf-8', { fatal: true });
const hits = [];
const withHit = new Set();
for (const file of files) {
  let text;
  try {
    text = utf8.decode(readFileSync(join(root, file)));
  } catch {
    continue; // missing or not UTF-8 (images, binaries)
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!OLD_NAME.test(lines[i].replace(PROTECTED_PATH, ''))) continue;
    withHit.add(file);
    if (!file.startsWith(DIST) && !ALLOWED.includes(file)) hits.push(`${file}:${i + 1}`);
  }
}

// The stale check only makes sense in this repository, not in a test's throwaway one.
const stale = files.includes('scripts/check-legacy-name.mjs')
  ? ALLOWED.filter((f) => !withHit.has(f))
  : [];

if (hits.length > 0) {
  console.log('The old name (AgentMesh) appears where it is not meant to:');
  for (const hit of hits) console.log(hit);
}
if (stale.length > 0) {
  console.log('ALLOWED lists files that no longer hold the old name (remove them):');
  for (const f of stale) console.log(f);
}
if (hits.length > 0 || stale.length > 0) process.exit(1);
console.log('The old name appears only where it is meant to.');
