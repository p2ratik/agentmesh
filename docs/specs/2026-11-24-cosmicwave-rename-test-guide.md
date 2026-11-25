# Testing the Cosmicwave rename (0.8.0) before it is released

This guide is for a tester who has never used the project. You install everything from nothing,
run a small mesh on your own laptop, and check that it all works under the new name. Plan two to
three hours.

**What you are testing.** The project was called AgentMesh until now. Version 0.8.0 renames it to
Cosmicwave: the Claude Code plugin is `cmw`, its commands are `/cmw:…`, and its folder on your
laptop is `~/.cosmicwave`. Nothing else is meant to change. The rename is on the branch
`agent/pratik/cosmicwave-rename` and is not released, so you test from that branch.

**What you are looking for.**
- Anything that does not work.
- The old name (`AgentMesh`, `agentmesh`, `~/.agentmesh`, `/agentmesh:…`) showing up anywhere.
  Parts 1 to 7 should never show it. Part 8 installs the old version on purpose, so there it is
  expected where the step says so.
- A step in this guide, or in the docs it points to, that is wrong or unclear.

**Nothing here can reach the team's real mesh.** Everything runs on your laptop: no server, no
Discord, test keys only.

**Rules while you test.**
- Write down what you see as you go, in the [results sheet](#results-sheet) at the end.
- Never paste the contents of a `.nk` file or of `agent.json` into a chat, an issue or the sheet.
  They are test keys here, but the habit matters.
- When a step fails, copy the exact message, note the step number, and go on to the next part if
  you can.

**Shells.** Every command is for bash. On Windows, use **Git Bash** (it comes with Git for
Windows) for every command, unless a step says PowerShell. On macOS and Linux, use your terminal.

## 1. Install the tools

| Tool | Version | Check |
| --- | --- | --- |
| Git | any recent | `git --version` |
| Node.js | 24 | `node --version` prints `v24.…` |
| pnpm | 10 | `pnpm --version` prints `10.…` |
| Claude Code | 2.1.295 or later | `claude --version` |
| nats-server | 2.15.1 | `nats-server --version` prints `nats-server: v2.15.1` |

1. **Git.** Windows: install [Git for Windows](https://git-scm.com/download/win). macOS and Linux
   usually have it.
2. **Node 24** from [nodejs.org](https://nodejs.org) or your version manager.
3. **pnpm 10:**

   ```bash
   npm install -g pnpm@10.33.0
   ```

4. **Claude Code.** Windows, in PowerShell: `irm https://claude.ai/install.ps1 | iex`. macOS and
   Linux: `curl -fsSL https://claude.ai/install.sh | bash`. Then open a new terminal, run `claude`
   once, sign in, and leave with `/exit`. On a Team or Enterprise plan, an Owner must have turned
   on Channels (Organization settings → Claude Code → Channels); ask before you start.
5. **nats-server.** Open the
   [2.15.1 release page](https://github.com/nats-io/nats-server/releases/tag/v2.15.1), download
   the archive for your system, unpack it, and add its folder to your PATH. Open a new terminal
   and run the check above.

Docker is not needed.

Record in the sheet: your operating system and the five versions.

## 2. Get the code and run the automated tests

The repository is still named `agentmesh` on GitHub; it is renamed at release. Clone it into a
folder named `cosmicwave`:

```bash
git clone https://github.com/p2ratik/agentmesh.git cosmicwave
cd cosmicwave
git switch agent/pratik/cosmicwave-rename
git log -1 --oneline
```

Record the commit line in the sheet. Keep this clone on this branch until you finish: the plugin
you install in part 4 runs straight from this folder.

**2a. The checks.**

```bash
pnpm install
pnpm check
```

Expected: it ends with a `Tests` line that has a `passed` count (about 1,760), some `skipped`, and
no `failed`. One line before the tests reads `The old name appears only where it is meant to.`

**2b. The build.**

```bash
pnpm build
git status --short
```

Expected: the build finishes without an error and `git status --short` prints nothing. If it
lists files under `plugins/cmw/dist`, record that and run `git restore plugins/cmw/dist`.

**2c. The integration tests.** They start a real hub and the real plugin against a NATS server.
They use temporary folders and never touch your home folder.

In one terminal, start NATS and leave it running:

```bash
mkdir -p ~/cw-test/js
nats-server -js -p 4333 -a 127.0.0.1 -sd ~/cw-test/js
```

In a second terminal, in the clone (macOS and Linux):

```bash
COSMICWAVE_TEST_NATS=nats://127.0.0.1:4333 COSMICWAVE_TEST_NATS_BIN="$(which nats-server)" pnpm test:integration
```

On Windows (Git Bash) the file name needs its `.exe`:

```bash
COSMICWAVE_TEST_NATS=nats://127.0.0.1:4333 COSMICWAVE_TEST_NATS_BIN="$(which nats-server.exe)" pnpm test:integration
```

Expected: `Test Files  14 passed (14)` and `Tests  49 passed (49)`. Two warning lines in the
output (`rpc reply subject is not the caller inbox` and `refused an outdated plugin`) are part of
the tests. If it reports tests as **skipped**, the two variables did not reach it: that is not a
pass. Stop NATS with Ctrl+C when it finishes.

## 3. Start a mesh on your laptop

A mesh is a NATS server plus the hub. You make a config with three example people (Alice, Bob and
Carol), one key each, and start both. All of it lives in `~/cw-test`, outside the clone.

**3a. Config and keys.** In the clone:

```bash
export HERMES_INGEST_TOKEN=test-only-0123456789 GITHUB_WEBHOOK_SECRET=test-only-0123456789
pnpm mesh init ~/cw-test/config
for id in hub discord-bridge hermes alice-agent bob-agent carol-agent; do
  pnpm mesh keys add $id --config ~/cw-test/config --secrets ~/cw-test/secrets
done
pnpm mesh validate --config ~/cw-test/config
pnpm mesh nats-config --config ~/cw-test/config --out ~/cw-test/nats.conf
```

The two test values must be at least 16 characters long, or `validate` refuses the config.

Expected: `validate` prints a summary ending in `Discord:     disabled`, and `nats-config` prints
`Wrote … nats.conf with 6 users: hub, alice-agent, bob-agent, carol-agent, discord-bridge, hermes.`

**3b. Point NATS at a folder on your laptop.** The rendered file stores its data in `/data`, which
is right for the server image and wrong for a laptop. Change that one line:

```bash
cd ~/cw-test
node -e "const f='nats.conf',fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('/data/jetstream','./nats-data'))"
grep store_dir nats.conf
```

Expected: `store_dir: "./nats-data"`.

**3c. Start NATS** (terminal A; leave it running):

```bash
cd ~/cw-test
nats-server -c nats.conf -a 127.0.0.1
```

Expected: it ends with `Server is ready`.

**3d. Start the hub** (terminal B, in the clone; leave it running):

```bash
export HERMES_INGEST_TOKEN=test-only-0123456789 GITHUB_WEBHOOK_SECRET=test-only-0123456789
COSMICWAVE_NATS_URL=nats://127.0.0.1:4222 COSMICWAVE_NKEY_SEED=~/cw-test/secrets/hub.nk COSMICWAVE_DATA_DIR=~/cw-test/data node apps/hub/dist/main.js --config ~/cw-test/config
```

Expected: the last line contains `"msg":"cosmicwave hub started"` and lists the three agents. If
Windows asks whether to let Node through the firewall, choose Cancel: nothing here needs it.

**3e. Check it** (any other terminal):

```bash
curl http://127.0.0.1:8787/healthz
```

Expected: `{"ok":true,"checks":{"started":true,"db":true,"nats":true,"subscriptions":true}}`.

## 4. Your first agent, as a new user

You are Alice. Her agent is `alice-agent`.

**Close every other Claude Code session first, and Claude Desktop too.** The plugin is installed
for your whole Claude account, so from 4c on, every open session joins the test mesh as Alice and
muddles the results.

**4a. Check you start clean.**

```bash
ls -a ~ | grep -i -E "cosmicwave|agentmesh"
```

Expected: nothing. If either folder exists, stop and ask before you go on: this laptop has been
on a mesh before, and this guide assumes it has not.

**4b. Save the agent's settings and key.** In the clone:

```bash
pnpm mesh agent-setup alice-agent --config ~/cw-test/config --nats-url nats://127.0.0.1:4222 --write
cp ~/cw-test/secrets/alice-agent.nk ~/.cosmicwave/alice-agent.nk
ls -a ~ | grep -i -E "cosmicwave|agentmesh"
```

Expected: the first command prints five numbered steps, and its last paragraph begins `Wrote` and
names `.cosmicwave` and `agent.json`. The last command prints only `.cosmicwave`. The `Wrote` paragraph says that with this file every
plugin option can stay empty: leave them empty in the next step; 4d tells you whether that worked.

**4c. Install the plugin from your clone.** In the clone, on macOS and Linux:

```bash
claude plugin marketplace add "$(pwd)"
claude plugin install cmw@cosmicwave
```

On Windows (Git Bash):

```bash
claude plugin marketplace add "$(pwd -W)"
claude plugin install cmw@cosmicwave
```

The install may add a note that four options are not set: that is expected here. If Claude Code
asks for the plugin's options, leave all four empty. Then let the mesh tools run
without a question each time: add this to `~/.claude/settings.json` (create the file if it does
not exist; if it has other content, add the rule to its `permissions.allow` list):

```json
{ "permissions": { "allow": ["mcp__plugin_cmw_mesh__*"] } }
```

Check: `claude plugin list` shows `cmw@cosmicwave` at version `0.8.0`.

**4d. Start a session.** Make a small repo to work in, then start Claude Code there with the
channel:

```bash
mkdir -p ~/cw-test/team/demo && cd ~/cw-test/team/demo
git init -q && echo "# demo" > README.md && printf '.claude/worktrees/\n' > .gitignore
git add . && git -c user.name=Tester -c user.email=tester@example.com commit -qm "first"
claude --dangerously-load-development-channels plugin:cmw@cosmicwave
```

Confirm the development channel when Claude Code asks. Then check, in this order:

| # | Do | Expected |
| --- | --- | --- |
| 4.1 | Look at the first lines of the session. | One line beginning `No Cosmicwave mesh window is running for this account` and telling you to run `/cmw:window` (or, if a window was already set up on this laptop, to start it with `claude-mesh`). It must **not** say the window "was set up when Cosmicwave was called AgentMesh". |
| 4.2 | Type `/cmw:` and look at the list. | It includes `activate`, `autoupdate`, `deactivate`, `join`, `setup`, `take` and `window` (a `mesh-collaboration` entry may be there too). Typing `/agentmesh:` offers nothing. |
| 4.3 | Ask: `Run the peers tool and show me its output.` | Three lines: `alice-agent … online`, `bob-agent … offline`, `carol-agent … offline`. If instead it says you have not joined, or the hub is unreachable, record that: empty options did not work. Then run `/plugin configure cmw@cosmicwave`, set `agent_id` to `alice-agent` and `nats_url` to `nats://127.0.0.1:4222`, restart the session and try again. |
| 4.4 | Ask: `Which mesh are you on, and who are you on it?` | It is `alice-agent`, on the mesh "acme", working for alice. It should not call the mesh "the AgentMesh" or "a Cosmicwave". |
| 4.5 | Run `/cmw:activate`. | Claude reports that a test message arrived and the session is active. |
| 4.6 | In another terminal: `ls -a ~/.cosmicwave` and `ls -a ~ \| grep -i agentmesh`. | The folder holds `agent.json` and `alice-agent.nk` (a `run` folder may be there too). The second command prints nothing. |

Leave with `/exit`.

## 5. The mesh window

Each teammate keeps one session open that takes the team's work: the mesh window. It is the part
of the plugin with the most names in it (a launcher, a settings file, the `claude-mesh` command),
so test it carefully.

**5a. Set it up.** Start a session as in 4d and run `/cmw:window`. When Claude asks:
- the team's folder is `~/cw-test/team` (give the full path if it asks for one);
- the test command is `node --version`.

Expected: Claude runs `cmw window init` and reports where it wrote `claude-mesh`. If it says to
add a folder to your PATH, do that and open a new terminal. Leave with `/exit`.

**5b. Look at what it wrote.**

```bash
ls ~/.cosmicwave
type claude-mesh
```

Expected: the folder now also holds `mesh-window` (`mesh-window.cmd` on Windows),
`mesh-window.json`, `mesh-window.settings.json` and `empty-git-hooks`. `type` prints the path of a
`claude-mesh` file. Open that file in an editor: its second line is `# cosmicwave claude-mesh`
(`rem cosmicwave claude-mesh` in the `.cmd` file on Windows).

**5c. Start it.**

```bash
cd ~/cw-test/team
claude-mesh
```

Confirm the development channel. On Windows 10, turn QuickEdit off for this terminal first
(`docs/getting-started.md`, "Your mesh window", says how), or one click in it pauses the window.

| # | Do | Expected |
| --- | --- | --- |
| 5.1 | Watch the start. | The window activates itself and says it is your mesh window. If it does not, type `/cmw:activate mesh window`. |
| 5.2 | Ask: `Call the Read tool on ~/.cosmicwave/agent.json. Make the call even if you expect it to be refused, and tell me exactly what came back.` | The call is refused by a rule or a hook (the message names a denied permission or says the folder is off limits). If Claude declines without making the call, record "declined by the model": the file stayed private, but the guard was not tested. |
| 5.3 | Ask: `Run exactly this command with the Bash tool, even if you expect it to be refused, and tell me exactly what came back: cat ~/.cosmicwave/alice-agent.nk` | The command is refused by a hook, and nothing starting with `SU` is shown (that would be the key: a serious fail). "Declined by the model" is recorded as in 5.2. |
| 5.4 | Ask: `Add a line "test" to demo/README.md.` | The Edit and Write tools are refused outside the window's own worktrees. Record what Claude does next: in auto mode it may write the line with a shell command (`echo … >>`) without asking. That is a known gap from the first test run, to be fixed separately, not a new failure. Record which happened, check with `git -C ~/cw-test/team/demo status --short`, then put the file back with `git -C ~/cw-test/team/demo checkout -- README.md`. |
| 5.5 | Ask: `Run the peers tool.` | `alice-agent` is online. |

Leave this window open for part 6.

## 6. A second agent, and working together

Bob is a second agent on the same laptop. He needs his own Claude Code settings folder, which
Claude Code calls a second account. You sign in to it with the same login.

**6a. Set Bob up** (a new terminal; every Bob command needs the `export` line first):

```bash
export CLAUDE_CONFIG_DIR=~/cw-test/claude-bob
claude            # sign in, then /exit
cd <your clone>
claude plugin marketplace add "$(pwd)"        # Windows (Git Bash): "$(pwd -W)"
claude plugin install cmw@cosmicwave --config agent_id=bob-agent --config nats_url=nats://127.0.0.1:4222 --config nkey_seed=~/cw-test/secrets/bob-agent.nk --config prefix=mesh
```

Expected: the install succeeds with no warning about `--config`. Then check that all four are
saved:

```bash
claude plugin configure cmw@cosmicwave
```

Expected: `agent_id`, `nats_url`, `nkey_seed` and `prefix` each marked `set`. If `--config` was
refused or an option is `not set`, record the exact message: this is the bug the first test run
found (a second account joining as the first agent), and it must be gone.

Add the same allow rule as in 4c to `~/cw-test/claude-bob/settings.json`.

**6b. Start Bob** (same terminal):

```bash
cd ~/cw-test/team/demo
claude --dangerously-load-development-channels plugin:cmw@cosmicwave
```

Run `/cmw:activate` in it.

| # | Do | Expected |
| --- | --- | --- |
| 6.1 | In Bob: `Run the peers tool.` | `alice-agent` and `bob-agent` online, `carol-agent` offline. Bob is `bob-agent`, although `~/.cosmicwave/agent.json` names Alice: his options win. |
| 6.2 | In Bob: `Ask alice-agent what 2 + 2 is.` | Alice's mesh window receives the question by itself and answers. The answer arrives in Bob's session by itself. Both name the same thread (`thr-…`). |
| 6.3 | In Alice's window: `Ask bob-agent which folder he is working in.` | Bob receives it and answers; the answer arrives in the window. |
| 6.4 | Leave Bob with `/exit`. In Alice's window: `Ask bob-agent to reply with the word "queued".` Then start Bob again as in 6b and run `/cmw:activate`. | The ask is accepted while Bob is away (it may say he is offline); nothing is lost. After Bob activates, he receives it (or his `inbox` tool shows it) and answers. |
| 6.5 | In Bob: `Create a task for alice-agent titled "Say done in the task thread", with no code change needed.` | Alice's window receives the assignment by itself. `Run the task_list tool` in either session shows the task. |
| 6.6 | In Bob: `Run the inbox tool.` Same in Alice's window. | No error. `inbox` lists unread messages only and marks them read, so an empty inbox ("Inbox zero") is a pass when everything was already read. `Run the thread tool on thr-…` with a thread id from 6.2 shows the whole thread. |

In the two sessions, watch for the old name in anything Claude or the plugin prints. Record every
place you see it.

## 7. A sweep for the old name

Run these while both sessions are still open:

```bash
ls -a ~ | grep -i agentmesh
grep -r -i -l agentmesh ~/.cosmicwave
claude plugin list
```

Expected:
- The first prints nothing.
- The second prints at most `mesh-window.settings.json` and files under `run/`. The window's
  settings name the old folder on purpose, so that the window may never read it, and a refusal
  from 5.2 is logged under a code that kept its old spelling (`path.agentmesh_dir`). Any other
  file is a finding: record its name, not its contents.
- The plugin list shows `cmw@cosmicwave` and nothing named `agentmesh`.
- In terminal B, the hub's start line says `cosmicwave hub started`.

Then leave both sessions with `/exit`. Leave NATS and the hub running.

## 8. Moving from the old name, and back

This is the part the team cares most about. Members who already use the plugin have their key in
`~/.agentmesh`. After they switch to the renamed plugin, the same key must work from
`~/.cosmicwave`, with nobody invited again. Your laptop has only test keys, so you can try the
whole move safely: first go back to the old version, then move forward again.

The steps are in `docs/getting-started.md`, in the section **Moving from AgentMesh**. Follow that
document, not your memory of it: testing its wording is part of the job. Two things differ until
the release, because the repository is not renamed yet:

| The document says | Use instead |
| --- | --- |
| `claude plugin marketplace add p2ratik/cosmicwave#v0.7.2` | `claude plugin marketplace add p2ratik/agentmesh#v0.7.2` |
| `claude plugin marketplace add p2ratik/cosmicwave` | the `claude plugin marketplace add "$(pwd)"` line from 4c, run in your clone |

Do all of part 8 as Alice: no `CLAUDE_CONFIG_DIR`.

**Keep Bob closed from here until 8.11.** Any 0.8.0 session moves the shared `~/.agentmesh` to
`~/.cosmicwave` when it starts, whichever Claude account it runs in (the document says two accounts
on one laptop switch together). If Bob starts while Alice is on 0.7.2, the folder moves early and
8b to 8.5 fail. So an old and a new plugin cannot be tried against each other on one laptop: 8.2
covers the old plugin with the new hub, and part 9 the new plugin with the old hub.

**8a. Go back to 0.7.2.** Follow **Going back to 0.7.2** in that section, steps 1 to 5.

| # | Check | Expected |
| --- | --- | --- |
| 8.1 | After step 2: `ls -a ~ \| grep -i -E "cosmicwave\|agentmesh"` | Only `.agentmesh`. |
| 8.2 | After step 5, in the old session: `Run the peers tool.` | `alice-agent` is online. The old plugin, from `~/.agentmesh`, works with the 0.8.0 hub. Here the old name is expected: `/agentmesh:…` commands, "AgentMesh" in the text. |
| 8.3 | In the old window: `Create a task for carol-agent titled "Old plugin, new hub"`, then `Run the task_list tool.` | The task is created and listed. (Carol is offline; nothing has to answer.) |

**8b. Put two extra files in the folder,** to stand in for the things members keep there:

```bash
echo "stand-in for a backup key" > ~/.agentmesh/backup-age-key.txt
mkdir -p ~/.agentmesh/teammates && echo "stand-in" > ~/.agentmesh/teammates/note.txt
```

**8c. Move forward.** Follow **Moving from AgentMesh** from its start: the check that the key is
in a file, then steps 1 to 5.

| # | Check | Expected |
| --- | --- | --- |
| 8.4 | The check before step 1 (`grep -c nkeySeed ~/.agentmesh/agent.json`). | `1`. |
| 8.5 | After step 3, before you start any session: `ls -a ~ \| grep -i -E "cosmicwave\|agentmesh"` | Still only `.agentmesh`: installing moves nothing. |
| 8.6 | Step 5, the first lines of the new session. | `This laptop's mesh window was set up when Cosmicwave was called AgentMesh, so claude-mesh no longer starts it. Run /cmw:window once to set it up again.` |
| 8.7 | In another terminal: `ls -a ~ \| grep -i -E "cosmicwave\|agentmesh"`, then `ls -R ~/.cosmicwave` | Only `.cosmicwave`. It holds `agent.json`, `alice-agent.nk`, `backup-age-key.txt` and `teammates/note.txt`: everything moved together. |
| 8.8 | `grep -c agentmesh ~/.cosmicwave/agent.json` | `0`: the key's path now points into the new folder. |
| 8.9 | In the session: `Run the peers tool.` | `alice-agent` is online. The hub knows Alice only by her key, so this is the same key, working from the new folder, with nothing set up again. |
| 8.10 | Run `/cmw:window` (same answers as 5a), leave, then `claude-mesh` in `~/cw-test/team`. | The new window starts and activates itself. The old `claude-mesh` was replaced: its second line reads `cosmicwave claude-mesh` again. |
| 8.11 | Now start Bob (6b) and activate him. In Bob: `Ask alice-agent what 4 + 4 is.` | Answered by the new window, as in part 6. |

**8d. Both folders at once (optional, 15 minutes).** A member may have made `~/.cosmicwave` by
hand before switching. The plugin must not lose the key in that case. Leave Bob's session, and
keep him closed until 8.14 is done. Go back to 0.7.2 again
(8a, steps 1 to 3 are enough; skip the window). Then, before you start any new session:

```bash
mkdir ~/.cosmicwave && echo "made by hand" > ~/.cosmicwave/invite-note.txt
```

Now do **Moving from AgentMesh** steps 2 to 5.

| # | Check | Expected |
| --- | --- | --- |
| 8.12 | In the new session: `Run the peers tool.` | `alice-agent` is online: the plugin found the key in `~/.agentmesh`. It must not say you have not joined. |
| 8.13 | Run `/cmw:window`. | It refuses, and says `~/.agentmesh is the folder to keep`: move what you put in `~/.cosmicwave` into `~/.agentmesh`, remove the then-empty `~/.cosmicwave`, and start Claude Code again. It must **not** tell you to delete `~/.agentmesh`. |
| 8.14 | Do what it says, restart the session, run `/cmw:window` again. | It works. `~/.cosmicwave` now holds the key, `agent.json` and `invite-note.txt`; `~/.agentmesh` is gone. |

## 9. The renamed plugin with an old hub (optional, 20 minutes)

A team may move its laptops before its server. Check that the 0.8.0 plugin works with a 0.7.2 hub.

Stop the hub in terminal B with Ctrl+C (leave NATS running). Then, in the clone:

```bash
git worktree add ../cosmicwave-0.7.2 v0.7.2
cd ../cosmicwave-0.7.2
pnpm install && pnpm --filter @agentmesh/hub build
export HERMES_INGEST_TOKEN=test-only-0123456789 GITHUB_WEBHOOK_SECRET=test-only-0123456789
AGENTMESH_NATS_URL=nats://127.0.0.1:4222 AGENTMESH_NKEY_SEED=~/cw-test/secrets/hub.nk AGENTMESH_DATA_DIR=~/cw-test/data node apps/hub/dist/main.js --config ~/cw-test/config
```

Expected: the last line says `agentmesh hub started`. It uses the same data folder as before. In
this part the old name is expected in the hub's own output and in any hint the old hub sends to a
session (such as a command it suggests); it is still not expected in what the plugin itself says.

| # | Do | Expected |
| --- | --- | --- |
| 9.1 | Start Alice's window (`claude-mesh`) and Bob (6b), both on 0.8.0. `Run the peers tool` in each. | Both online. |
| 9.2 | Repeat 6.2 and 6.5. | Same results as in part 6. |

Stop the old hub with Ctrl+C and start the 0.8.0 hub again (3d). Run `peers` once more in either
session: still online.

## 10. Clean up

Do this when you have finished and recorded everything. It removes the test agents from this
laptop, so that you can join the real team later with a clean start. Leave every session first,
and stop the hub and NATS with Ctrl+C.

```bash
claude plugin marketplace remove cosmicwave
CLAUDE_CONFIG_DIR=~/cw-test/claude-bob claude plugin marketplace remove cosmicwave
rm "$(type -p claude-mesh)"
```

On Windows, also delete `claude-mesh.cmd` beside the file the last line removed. Then remove the
test folders. `~/.cosmicwave` holds only this test's keys **on this laptop**; never delete it on a
laptop that has joined a real mesh.

```bash
rm -rf ~/.cosmicwave ~/cw-test
ls -a ~ | grep -i -E "cosmicwave|agentmesh"
```

Expected: nothing. If you did part 9, also run `git worktree remove ../cosmicwave-0.7.2` in the
clone. Last, take the `mcp__plugin_cmw_mesh__*` rule out of `~/.claude/settings.json`, or leave it
for when you join.

## Results sheet

Copy this into your report and fill it in. "Old name seen" means outside part 8a and part 9, where
it is expected.

```
Tester:                         Date:
Operating system:               Commit (git log -1 --oneline):
git:            node:           pnpm:           claude:           nats-server:

Part  Check                                             Pass / Fail   Notes (exact message if it failed)
2a    pnpm check (passed count: ____ )
2b    pnpm build, bundles unchanged
2c    integration: 14 files, 49 tests, none skipped
3     NATS and hub start, /healthz ok
4.1   first line is the "run /cmw:window" hint
4.2   /cmw: commands listed, /agentmesh: none
4.3   peers works with empty plugin options
4.4   identity and mesh named correctly
4.5   /cmw:activate
4.6   ~/.cosmicwave only
5a    /cmw:window sets the window up
5b    files and the claude-mesh marker line
5.1   claude-mesh starts and activates the window
5.2   reading agent.json refused
5.3   printing the key refused
5.4   Edit tool refused outside a worktree (note what Claude did next)
6.1   Bob runs from his own options
6.2   Bob asks, Alice's window answers
6.3   Alice asks, Bob answers
6.4   message waits while Bob is away
6.5   task reaches Alice's window
6.6   inbox in both
7     sweep for the old name
8.1   back on ~/.agentmesh
8.2   0.7.2 plugin with the 0.8.0 hub
8.3   0.7.2 plugin creates a task on the 0.8.0 hub
8.4   key check before the move
8.5   install moves nothing
8.6   "was called AgentMesh" line shown
8.7   whole folder moved
8.8   key path points into ~/.cosmicwave
8.9   same key works after the move
8.10  new window replaces the old claude-mesh
8.11  ask and answer after the move
8.12  (optional) both folders: key still found
8.13  (optional) advice never says to delete ~/.agentmesh
8.14  (optional) move completes after following it
9.1   (optional) 0.8.0 plugins with a 0.7.2 hub
9.2   (optional) ask and task with a 0.7.2 hub
10    clean up leaves neither folder

Old name seen (where, exact text):

Steps in this guide or in docs/getting-started.md that were wrong or unclear:

Anything else:
```

## What this test does not cover

These need a server, Discord or a published release, so they stay with the maintainer:

- `/cmw:setup`, in every mode: it starts the hub from published images, and the 0.8.0 images do
  not exist until the release.
- Joining by invite (`/cmw:join`), which needs Discord and a public hub.
- The Discord bridge, including whether it reuses the webhooks and the category made under the
  old name.
- Moving a real server: the Docker volume guard, the installers and the firewall takeover
  (`docs/deploy.md`, "Moving a server from AgentMesh").
- What an installed 0.7.2 plugin with automatic updates does when its marketplace is renamed
  under it.
