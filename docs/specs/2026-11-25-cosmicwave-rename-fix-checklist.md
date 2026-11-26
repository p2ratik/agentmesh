# Cosmicwave rename (0.8.0): open fixes

Everything still open on `agent/pratik/cosmicwave-rename` before it can merge, from the final code
review (19 November) and from Suhani's test runs (24 and 25 November). Tick a line when its fix is
committed.

Sources: the tester's guide (`2026-11-24-cosmicwave-rename-test-guide.md`), Suhani's results
sheet, her interactive runbook and her answers of 25 November. F1 to F15 are the numbers in her
sheet. Her run was on Windows 11 with Claude Code 2.1.330, at commit `f2dec53`.

**Verdict so far.** Nothing found is a fault in the rename itself: the folder move, the key, the
names and both cross-version directions passed wherever they were tested. Two findings are real
product bugs that are older than the rename (F10, F11). The rest are test, build, text and guide
problems.

## A. Must fix before the branch merges

- [x] **F4. The committed `plugins/cmw/dist/cli.js` does not match a fresh build.** Confirmed
  here: one import statement differs in layout, because the source was reformatted after the last
  build. CI compares the bundles with a fresh build on every pull request, so the PR fails until
  the plugin is rebuilt and the bundles committed. Do this last, after every other code fix.
- [x] **F2. `tests/deploy/legacy-names.test.ts` sources its script through an unquoted path**
  (two places). `pnpm check` fails for anyone whose clone is in a folder with a space in its name.
  New in this branch. Fix: quote the path; check the other `tests/deploy` files for the same.
- [x] **F10 (step 6.1). A second Claude account on the laptop joins as the first agent.**
  Confirmed with a throwaway plugin on Claude Code 2.1.330:
  - `plugin.json` declares the four options under `channels[0].userConfig`. For such a plugin,
    `claude plugin install --config …` answers "declares no userConfig options" and
    `claude plugin configure` answers "has no options to set".
  - Claude Code never asked Suhani for the options either, at install or at first start, and
    `/plugin` offered nothing to set.
  - So a new install has no way to enter `agent_id` and the rest. The plugin then falls back to
    `~/.cosmicwave/agent.json`, and the second account acts as the first account's agent.
  - Values already saved the old way (`pluginConfigs[…].mcpServers.mesh` in `settings.json`) are
    still passed to the plugin, which is why laptops set up earlier keep working. The uninstall
    that the rename needs deletes them.
  - Older than the rename: 0.7.2 has the same layout.
  - Fix: declare `userConfig` at the top level of `plugins/cmw/.claude-plugin/plugin.json` (the
    form the CLI and `/plugin` cover), keep the channel entry without it, and test that
    `--config` values reach the server and the hook, the secret one (`nkey_seed`) included.
    0.8.0 is the moment: everyone reinstalls,
    so nobody has saved values to carry over. Then correct `docs/getting-started.md`
    ("Configure by hand") and `docs/configuration.md` to say how options are entered.
- [x] **F1. The guide's test secrets are too short** (`test-only`; the config needs 16 or more
  characters). Step 3a and 3d of the guide. See section C.

## B. Fix in the same pass (small, real)

- [x] **F3. Three deploy tests time out under the full `pnpm check` on Windows.** Two in
  `tests/deploy/volume-guard.test.ts` ("deploys on a server with no agentmesh volumes" and
  "deploys when COMPOSE_PROJECT_NAME=agentmesh is set"), which has no timeout of its own and so
  gets 20 seconds; one in `cosmicwave-backup.test.ts` ("replaces the hourly copy on later runs
  …"), which has 60. All three pass alone. Fix: 120 seconds for the tests in both files that
  build git repositories and run a script. Not reproduced here. The same run on a loaded laptop
  also timed out `tests/repo/legacy-name.test.ts` ("passes on this repository", 24 seconds
  against 20), which now has 120 seconds too.
- [x] **F5, F6. `cmw agent-setup` text.** After `--write` it says `agent_id and nats_url must
  still be entered in the plugin options`. That is false: with `agent.json` in place the options
  can stay empty (Suhani's 4.3 passed that way). The same sentence is in the command's help.
  Step 3 of its output ("enter these when Claude Code asks") is the by-hand path and stays, but
  reword it once F10 decides how options are entered.
- [x] **F7. `cmw agent-setup` prints the marketplace path unquoted,** so the printed command
  breaks when the path has a space. Fix: quote it.
- [x] **R1. `docs/deploy.md`, "Going back" on a server with automatic deploys:** the step uses
  tag-only image names with `up --pull never`, but those images were pulled by digest and carry
  no tag, so it stops with "No such image". Fix: pull first, without the condition.
- [x] **R2. `docs/deploy.md`, the older by-hand list** runs `vm-setup.sh` without
  `COSMICWAVE_DIR=/opt/agentmesh`, which contradicts the newer section.
- [x] **R3. `docs/getting-started.md`, "Going back" step 3** does not tell a member whose
  settings lived only in plugin options to enter them again.

## C. The tester's guide and Suhani's runbook

The guide is staged, not committed. Each line applies to both documents unless it names one.

- [x] **F1.** Use test values of 16 or more characters in 3a and 3d (the runbook already does).
- [x] **F14 (step 8.4). Remove 8.3, and keep Bob closed for all of part 8.** Any 0.8.0 session
  moves the shared `~/.agentmesh` when it starts, whichever Claude account it runs in. Starting
  Bob in 8.3 moved the folder before 8b and 8c, so 8b and 8.4 failed. The product did what the
  docs say (two accounts on one laptop switch together); the guide was wrong, and so is its line
  "Bob stays on 0.8.0 the whole time" and the runbook's "Bob can stay open". An old plugin and a
  new one cannot be tested against each other on one laptop; part 9 and 8.2 cover the two
  directions separately.
- [x] **F11 (step 5.4). The expected result is wrong for auto mode.** See section D. Until that
  is decided, 5.4 should say: the Edit tool is refused; if Claude writes the line with a shell
  command instead, record it, and check afterwards whether the file changed.
- [x] **F12 (step 6.6).** `inbox` lists unread messages only and marks them read, so an empty
  inbox is a pass. Say "no error; an empty inbox is fine".
- [x] **Steps 5.2 and 5.3 did not test the guard.** The model declined by itself without calling
  a tool. Reword both so a tool call is made (for example "Use the Read tool on …" and "Run
  exactly this command, then tell me what happened: …"), and say that the pass is the hook's
  refusal, not Claude's own.
- [x] **Step 6a.** The fallback "set the options in `/plugin`" does not exist for this plugin
  today. After F10, `--config` works and the fallback can go.
- [x] **Before part 4:** close every other Claude Code session and Claude Desktop. The plugin is
  installed for the whole account, so each open session joins the test mesh as Alice.
- [x] **Step 2:** a clone in a path with spaces works again now that F2 is fixed.
- [x] **Step 4.1:** when a window is already set up, the line ends "Start it with claude-mesh",
  not "Run /cmw:window". Both are right.
- [ ] **Before any rerun on Suhani's laptop (F15):** restore the two bundles someone edited by
  hand at 03:55 on 25 November (`git restore plugins/cmw/dist` in her clone). Her results for
  6.2 to 6.4 and part 8 after that time came from edited code and need running again.

## D. Noted, not being fixed now

Pratik's decision on 25 November: these stay as notes and do not hold the rename.

- [ ] **F11 (step 5.4). Shell writes outside a worktree in auto mode. Confirmed in a live
  window:** in auto mode it ran `cd …/demo && echo "test" >> README.md` with no question, and the
  file changed. In auto mode the guard
  refuses the Edit and Write tools outside a mesh worktree, but a shell command that writes a
  file (`echo … >>`, `sed -i`, `tee`, PowerShell `Add-Content`) goes to Claude Code's own
  auto-mode check, which allows it when the person at the keyboard asked for it. This is the
  documented trade from 0.7.0 (ADR 0012, Consequences: "Bash writes outside worktrees no longer
  ask in auto mode"), not a regression. Options: leave it as documented; or add shell writes
  outside a mesh worktree to the guard's "ask" floor, and refuse commands that name the plugin's
  own folder, so a window can never edit its own guard. The second is a security change with its
  own tests and an ADR update, and belongs in its own change, not in the rename.
- [ ] **F8. `peers` pairs one session's repo with another's branch.** A hub bug, the same on
  `main`: one row per agent, with repo and branch updated separately. Proposed as its own task.
- [ ] **F13 (step 6.5). `task_create` cannot choose a workflow,** so a no-code task gets the
  `feature` workflow, which needs a PR. The hub accepts a workflow; the plugin's tool does not
  pass one. Same on `main`. A small addition, not urgent.
- [x] **F9. A warning from `pnpm install` on a fresh clone** (`Failed to create bin at …
  .bin\cmw`). No fix needed: the CLI's `bin` points at `dist/main.js`, which does not exist until
  the first build. `main` has the same layout, the install finishes, and the warning is gone once
  the project has been built.

## E. Open questions

- [ ] **F15. Who edited the bundles on Suhani's laptop?** Not the mesh window and not Alice's
  sessions: their transcripts hold no such edit. It was Bob's ordinary session (its transcript
  was deleted at cleanup) or Suhani by hand; she is to confirm. Either way it is test hygiene,
  not the window changing its own guard.

## F. Still to test, after the fixes

- [ ] Suhani's remaining steps, on unedited bundles and after the fixes: 4.2 (the `/cmw:`
  list was not recorded); 5.2 and 5.3 with a real tool call; all of part 6 (6.1 after F10; 6.2
  to 6.6 ran on edited code); 8.1, 8.2, 8.4 to 8.6, 8.10 and 8.11 (all of her live part 8 ran on
  edited code); the cleanup. Passed and kept: 4.1, 4.3 to 4.6, 5a, 5b, 5.1, 5.5, part 7, the
  scripted 8.7 to 8.9 and 8.12 to 8.14, and part 9 for one agent.
- [ ] Which shell `claude-mesh` was typed in for 5.1 (PowerShell is the untested one).
- [ ] Release gate: a 0.7.2 plugin against the 0.8.0 hub and the reverse, with real sessions
  (ask, reply, a task, a review). One call each way has passed in a scratch run.
- [ ] Release gate: a real uninstall and reinstall on Pratik's Windows laptop.
- [x] **Simulated on 26 November** (a throwaway git marketplace and plugin in a scratch Claude
  Code 2.1.330 config, renamed underneath an installed copy): once the marketplace is refreshed,
  the old plugin is listed as `failed to load` ("Plugin … not found in marketplace …"). Its
  cached files stay, and nothing is deleted. So after a merge to `main`, a member whose
  marketplace refreshes (automatic updates on, or a manual `marketplace update`) loses the mesh in
  every session started after that, until they do the move in `docs/getting-started.md`. Members
  with automatic updates off are not touched. A refresh that cannot reach the repository changes
  nothing. Not seen, because it needs a signed-in session: whether a session with the plugin in
  that state still runs its hooks.
- [ ] **Doc to add:** after such a refresh the marketplace keeps its old local name, and the new
  plugin can be installed from it as `cmw@agentmesh`. That id does not match the launcher's
  channel or the docs, so the moving steps must say: remove the old marketplace first, never
  install `cmw` from it.
- [ ] Release gate: what an installed 0.7.2 plugin with automatic updates does when its
  marketplace is renamed under it. Settle this before merging: the plugin's hooks block every
  tool call if they break.
- [ ] The server steps in `docs/deploy.md`, on the live server.
