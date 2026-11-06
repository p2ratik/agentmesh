import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/guard.ts
import { homedir } from "node:os";

// ../../packages/common/src/version.ts
var VERSION = "0.6.0";

// ../../packages/common/src/window.ts
import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
var MESH_WINDOW_ENV = "AGENTMESH_MESH_WINDOW";
var CHANNEL_FLAG = "--dangerously-load-development-channels plugin:agentmesh@agentmesh";
var RESTART = `claude ${CHANNEL_FLAG}`;
var launcherName = (platform) => platform === "win32" ? "mesh-window.cmd" : "mesh-window";
function windowFiles(home, platform) {
  const { join: join4 } = platform === "win32" ? win32 : posix;
  const dir = join4(home, ".agentmesh");
  return {
    dir,
    policy: join4(dir, "mesh-window.json"),
    settings: join4(dir, "mesh-window.settings.json"),
    launcher: join4(dir, launcherName(platform)),
    emptyHooks: join4(dir, "empty-git-hooks"),
    bin: join4(dir, "bin")
  };
}
var TOKEN_PATTERN = /^[0-9a-f]{32}$/;
var PARTICIPANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
var MAX_TEST_COMMANDS = 10;
function isBranchName(v) {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(v) && !v.includes("..");
}
var endsAsPrefix = (v) => /[/_.]$/.test(v);
function isTestCommand(v) {
  return /^[A-Za-z0-9][A-Za-z0-9 ._:/=@-]{0,199}$/.test(v) && !v.includes("  ") && !v.endsWith(" ");
}
function parseWindowPolicy(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const p = v;
  const { agentId, token, ownBranchPrefix: prefix, integrationBranch, testCommands } = p;
  if (p.version !== 1) return null;
  if (typeof agentId !== "string" || !PARTICIPANT_PATTERN.test(agentId)) return null;
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const prefixOk = typeof prefix === "string" && isBranchName(prefix) && endsAsPrefix(prefix);
  if (prefix !== null && !prefixOk) return null;
  if (typeof integrationBranch !== "string" || !isBranchName(integrationBranch)) return null;
  if (!Array.isArray(testCommands) || testCommands.length > MAX_TEST_COMMANDS || !testCommands.every((c) => typeof c === "string" && isTestCommand(c))) {
    return null;
  }
  return { version: 1, agentId, token, ownBranchPrefix: prefix, integrationBranch, testCommands };
}
function readWindowPolicy(home, platform) {
  try {
    return parseWindowPolicy(readFileSync(windowFiles(home, platform).policy, "utf8"));
  } catch {
    return null;
  }
}
function markerState(env, policy, agentId) {
  const value = env[MESH_WINDOW_ENV];
  if (!value) return { state: "none", policy: null };
  if (policy && policy.token === value && (agentId === void 0 || policy.agentId === agentId)) {
    return { state: "verified", policy };
  }
  return { state: "marked", policy: null };
}
function readMarker(env, home, platform, agentId) {
  if (!env[MESH_WINDOW_ENV]) return { state: "none", policy: null };
  return markerState(env, readWindowPolicy(home, platform), agentId);
}

// src/guard/checkout.ts
import { lstatSync as lstatSync2, readdirSync, readFileSync as readFileSync3 } from "node:fs";
import path2 from "node:path";

// src/guard/paths.ts
import { lstatSync, readFileSync as readFileSync2, realpathSync } from "node:fs";
import path from "node:path";
var NOT_ABSOLUTE = { refused: "the path is not absolute" };
var DEVICE = { refused: "device, UNC and stream paths are refused" };
var OUTSIDE = { refused: "not inside .claude/worktrees/mesh-*" };
var UNREGISTERED = { refused: "not a registered git worktree" };
var DOT_GIT = { refused: ".git is off limits" };
var AGENTMESH = { refused: "~/.agentmesh is off limits" };
var lib = (o) => o.platform === "win32" ? path.win32 : path.posix;
function attempt(fn) {
  try {
    return fn();
  } catch {
    return void 0;
  }
}
function key(segment, o) {
  if (o.platform === "win32") return segment.toUpperCase();
  if (o.platform === "darwin") {
    const visible = segment.normalize("NFC").replace(new RegExp("\\p{Cf}", "gu"), "");
    return visible.toUpperCase();
  }
  return segment;
}
function split(file, o) {
  const p = lib(o);
  const top = p.parse(file).root;
  return { top, segments: file.slice(top.length).split(p.sep).filter(Boolean) };
}
var keys = (file, o) => {
  const { top, segments } = split(file, o);
  return [key(top, o), ...segments.map((s) => key(s, o))];
};
var refusalKey = (k) => k.normalize("NFC").replace(new RegExp("\\p{Cf}", "gu"), "").toUpperCase();
function within(inner, outer, o) {
  const a = keys(inner, o).map(refusalKey);
  const b = keys(outer, o).map(refusalKey);
  return b.length <= a.length && b.every((k, i) => k === a[i]);
}
var DOS_DEVICE = /^(con|prn|aux|nul|com[0-9\xb9\xb2\xb3]|lpt[0-9\xb9\xb2\xb3]|conin\$|conout\$) *(\.|$)/i;
function badInput(file, o) {
  if (typeof file !== "string" || file.includes("\0") || file !== file.trim()) return NOT_ABSOLUTE;
  const win = o.platform === "win32";
  if (win && /^[\\/]([\\/]|\?\?[\\/])/.test(file)) return DEVICE;
  const segments = file.split(win ? /[\\/]/ : "/");
  if (segments.some((s) => s === "." || s === "..")) return NOT_ABSOLUTE;
  if (!win) return file.startsWith("/") ? null : NOT_ABSOLUTE;
  if (!/^[a-z]:[\\/]/i.test(file)) return NOT_ABSOLUTE;
  if (file.includes(":", 2)) return DEVICE;
  return segments.slice(1).some((s) => /[. ]$/.test(s) || DOS_DEVICE.test(s)) ? DEVICE : null;
}
function realOrMissing(file) {
  const real = attempt(() => realpathSync.native(file));
  if (real !== void 0) return real;
  try {
    lstatSync(file);
    return null;
  } catch (error) {
    return error.code === "ENOENT" ? file : null;
  }
}
function resolve(file, o) {
  const p = lib(o);
  const { top, segments } = split(p.resolve(file), o);
  let current = top;
  for (const segment of segments) {
    const next = realOrMissing(p.join(current, segment));
    if (next === null) return null;
    current = next;
  }
  return current;
}
function escapes(file, resolved, o) {
  if (attempt(() => lstatSync(lib(o).resolve(file)))?.isSymbolicLink()) return true;
  const target = attempt(() => lstatSync(resolved));
  return target !== void 0 && !target.isDirectory() && target.nlink > 1;
}
function realFile(file, o) {
  return badInput(file, o) ? void 0 : attempt(() => realpathSync.native(file));
}
var readLine = (file) => attempt(() => readFileSync2(file, "utf8"))?.replace(/[\r\n]+$/, "");
function registered(resolved, o) {
  const p = lib(o);
  const { top, segments } = split(resolved, o);
  const k = segments.map((s) => key(s, o));
  let i = k.length - 3;
  while (i >= 0 && !(k[i] === key(".claude", o) && k[i + 1] === key("worktrees", o))) i--;
  if (i < 0 || !k[i + 2]?.startsWith(key("mesh-", o))) return OUTSIDE;
  const root = p.join(top, ...segments.slice(0, i + 3));
  const dotGit = p.join(root, ".git");
  if (!attempt(() => lstatSync(dotGit))?.isFile()) return UNREGISTERED;
  const pointer = /^gitdir: (.+)$/.exec(readLine(dotGit) ?? "")?.[1];
  const gitDir = pointer === void 0 ? void 0 : realFile(p.resolve(root, pointer), o);
  if (gitDir === void 0 || !attempt(() => lstatSync(p.join(gitDir, "commondir")))) {
    return UNREGISTERED;
  }
  const back = readLine(p.join(gitDir, "gitdir"));
  const backReal = back ? realFile(p.resolve(gitDir, back), o) : void 0;
  const dotGitReal = realFile(dotGit, o);
  if (!backReal || !dotGitReal || keys(backReal, o).join("/") !== keys(dotGitReal, o).join("/")) {
    return UNREGISTERED;
  }
  const head = readLine(p.join(gitDir, "HEAD")) ?? "";
  const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
  return { worktree: { root, gitDir, branch }, below: k.slice(i + 3) };
}
function located(file, o) {
  const bad = badInput(file, o);
  if (bad) return bad;
  return resolve(file, o) ?? OUTSIDE;
}
function meshWorktreeOf(file, o) {
  const resolved = located(file, o);
  if (typeof resolved !== "string") return resolved;
  const found = registered(resolved, o);
  return "refused" in found ? found : found.worktree;
}
function editTarget(file, o) {
  const resolved = located(file, o);
  if (typeof resolved !== "string") return resolved;
  if (typeof o.home !== "string") return NOT_ABSOLUTE;
  const p = lib(o);
  const agentmesh = p.isAbsolute(o.home) ? resolve(p.join(o.home, ".agentmesh"), o) : null;
  if (agentmesh === null || within(resolved, agentmesh, o)) return AGENTMESH;
  const found = registered(resolved, o);
  if ("refused" in found) return found;
  if (found.below.length === 0) return OUTSIDE;
  if (found.below.some((k) => refusalKey(k) === ".GIT")) return DOT_GIT;
  return escapes(file, resolved, o) ? OUTSIDE : { ok: true };
}

// src/guard/checkout.ts
var lib2 = (o) => o.platform === "win32" ? path2.win32 : path2.posix;
var code = (error) => error.code;
function kind(file) {
  try {
    return lstatSync2(file).isDirectory() ? "dir" : "other";
  } catch (error) {
    return code(error) === "ENOENT" ? "missing" : "other";
  }
}
function checkoutTop(dir, o) {
  if (badInput(dir, o)) return null;
  const p = lib2(o);
  if (kind(p.join(dir, ".git")) !== "dir") return null;
  const claude = kind(p.join(dir, ".claude"));
  if (claude === "other") return null;
  if (claude === "dir" && kind(p.join(dir, ".claude", "worktrees")) === "other") return null;
  return dir;
}
function freeSlot(top, name, o) {
  return kind(lib2(o).join(top, ".claude", "worktrees", name)) === "missing";
}
var OID = "[0-9a-f]{40}(?:[0-9a-f]{24})?";
var LOOSE = new RegExp(`^(?:${OID}|ref: refs/\\S+)\\r?\\n?$`);
var PACKED = new RegExp(`^${OID} (.+)$`);
var plain = (s) => s !== "" && !s.startsWith(".") && !s.endsWith(".") && !s.endsWith(".lock");
function read(file) {
  try {
    return readFileSync3(file, "utf8");
  } catch {
    return null;
  }
}
function looseRef(git, segments, o) {
  const p = lib2(o);
  let at = p.join(git, "refs", "remotes", "origin");
  for (const s of segments) {
    let names;
    try {
      names = readdirSync(at);
    } catch (error) {
      return code(error) === "ENOENT" || code(error) === "ENOTDIR" ? "missing" : "refused";
    }
    if (!names.includes(s)) {
      const fold = (n) => key(n, o).toUpperCase();
      return names.some((n) => fold(n) === fold(s)) ? "refused" : "missing";
    }
    at = p.join(at, s);
  }
  return at;
}
function remoteRefExists(top, branch, o) {
  if (typeof branch !== "string" || !isBranchName(branch)) return false;
  const segments = branch.split("/");
  if (!segments.every(plain)) return false;
  const p = lib2(o);
  const git = p.join(top, ".git");
  if (kind(p.join(git, "reftable")) !== "missing") return false;
  const loose = looseRef(git, segments, o);
  if (loose === "refused") return false;
  if (loose !== "missing") {
    try {
      return lstatSync2(loose).isFile() && LOOSE.test(read(loose) ?? "");
    } catch {
      return false;
    }
  }
  const name = `refs/remotes/origin/${branch}`;
  const lines = read(p.join(git, "packed-refs"))?.split(/\r?\n/) ?? [];
  return lines.some((line) => PACKED.exec(line)?.[1] === name);
}

// src/guard/commands.ts
import { resolve as resolve2, sep } from "node:path";
var NO_POLICY = "mesh window: ~/.agentmesh/mesh-window.json is missing or invalid, so every command needs your human's approval";
var TEST_OUTSIDE = "mesh window: run tests inside a task worktree (cd <worktree> && <test>)";
var UNLISTED = "mesh window: this command isn't on the window's list, so your human decides";
var foreign = (branch) => `mesh window: ${branch ?? "a detached checkout"} isn't your branch, so running its tests needs your human's approval`;
var ask = (reason) => ({ ask: reason });
var pass = () => ({ pass: true });
var PATH_RAW = "(?!-|//)(?:[A-Za-z]:(?=/))?[A-Za-z0-9._/-]+";
var PATH_QUOTED = "(?!-|//)(?:[A-Za-z]:(?=/))?[A-Za-z0-9._/ -]+";
var PATH = `(?:${PATH_RAW}|"${PATH_QUOTED}")`;
var MESSAGE = String.raw`'[\x20-\x26\x28-\x5b\x5d-\x7e]*'`;
var BRANCH = "([A-Za-z0-9][A-Za-z0-9._/-]*)";
var MESH = String.raw`\.claude/worktrees/(mesh-[a-z0-9][a-z0-9-]{0,62})`;
var EXACT = /* @__PURE__ */ new Set(["pwd", "git status", "git fetch origin", "git worktree list"]);
var READ = /^(?:ls|git (?:diff|log|show))((?: [A-Za-z0-9._/:@^~=,-]+)*)$/;
var CD = new RegExp(`^cd ${PATH}$`);
var WORKTREE_OWN = new RegExp(`^git worktree add ${MESH} -b ${BRANCH} --track origin/${BRANCH}$`);
var WORKTREE_REVIEW = new RegExp(`^git worktree add ${MESH} refs/remotes/origin/${BRANCH}$`);
var WORKTREE_REMOVE = new RegExp(`^git worktree remove ${MESH}$`);
var CD_AND = new RegExp(`^cd (?:(${PATH_RAW})|"(${PATH_QUOTED})") && (.+)$`);
var ADD = new RegExp(`^git add (?:-A|--(?: ${PATH})+)$`);
var COMMIT = new RegExp(`^git commit(?: -m ${MESSAGE})+$`);
var PUSH = new RegExp(`^git push (?:-u )?origin ${BRANCH}$`);
var PR = new RegExp(
  `^gh pr create --base ${BRANCH} --head ${BRANCH}(?: --title ${MESSAGE})?(?: --body ${MESSAGE})?$`
);
function safe(arg) {
  if (/^(?:--output|--no-index|\/|~|[A-Za-z]:)/.test(arg)) return false;
  return !arg.includes("//") && !arg.split("/").includes("..");
}
function reads(command, c) {
  const m = READ.exec(command);
  if (m === null) return false;
  const args = (m[1] ?? "").split(" ").slice(1);
  if (!args.every(safe)) return false;
  if (args.length === 0 || !command.startsWith("git ")) return true;
  return c.worktreeOf(c.cwd) !== null || c.checkoutTop(c.cwd) !== null;
}
function ownStart(branch, start, p) {
  const prefix = p.ownBranchPrefix;
  return prefix !== null && branch.length > prefix.length && branch.startsWith(prefix) && isBranchName(branch) && start === p.integrationBranch;
}
function worktreeChange(command, c, p) {
  const own = WORKTREE_OWN.exec(command);
  const review = WORKTREE_REVIEW.exec(command);
  if (!own && !review && !WORKTREE_REMOVE.test(command)) return null;
  const top = c.checkoutTop(c.cwd);
  if (top === null) return false;
  const add = own ?? review;
  if (!add) return true;
  if (!c.freeSlot(top, add[1] ?? "")) return false;
  if (review) {
    const branch = review[2] ?? "";
    return isBranchName(branch) && c.remoteRefExists(top, branch);
  }
  return own !== null && ownStart(own[2] ?? "", own[3], p);
}
var anchored = (path3) => path3.startsWith("./") || (sep === "\\" ? /^[A-Za-z]:\//.test(path3) : path3.startsWith("/"));
function placed(command, cwd) {
  const m = CD_AND.exec(command);
  if (!m) return { dir: cwd, rest: command };
  const path3 = m[1] ?? m[2] ?? "";
  const rest = m[3] ?? "";
  if (!anchored(path3) || path3.split("/").includes("..") || rest.startsWith("cd ")) return null;
  return { dir: resolve2(cwd, path3), rest };
}
function delivers(rest, branch, p) {
  if (ADD.test(rest) || COMMIT.test(rest)) return true;
  const push = PUSH.exec(rest);
  if (push) return push[1] === branch;
  const pr = PR.exec(rest);
  return pr !== null && pr[1] === p.integrationBranch && pr[2] === branch;
}
var isDelivery = (rest) => [ADD, COMMIT, PUSH, PR].some((r) => r.test(rest));
function inWorktree(command, c, p) {
  const test = p.testCommands.includes(command);
  if (!test && !isDelivery(command)) return ask(UNLISTED);
  const wt = c.worktreeOf(c.cwd);
  const branch = wt?.branch ?? null;
  const prefix = p.ownBranchPrefix;
  const own = branch !== null && prefix !== null && branch.startsWith(prefix);
  if (test) return own ? pass() : ask(wt ? foreign(branch) : TEST_OUTSIDE);
  return own && delivers(command, branch, p) ? pass() : ask(UNLISTED);
}
function listed(command, c, p) {
  if (EXACT.has(command) || reads(command, c)) return pass();
  const change = worktreeChange(command, c, p);
  if (change !== null) return change ? pass() : ask(UNLISTED);
  return inWorktree(command, c, p);
}
function classifyCommand(command, c) {
  const p = c.policy;
  if (!p) return ask(NO_POLICY);
  if (typeof command !== "string" || typeof c.cwd !== "string") return ask(UNLISTED);
  if (CD.test(command)) return pass();
  const at = placed(command, c.cwd);
  return at === null ? ask(UNLISTED) : listed(at.rest, { ...c, cwd: at.dir }, p);
}

// src/relay/address.ts
var WINDOWS_UDS = /^uds:\\\\\.\\pipe\\LOCAL\\cc-msg-([0-9a-f]{32})$/;
function udsHex(address, platform) {
  if (platform !== "win32" || typeof address !== "string") return null;
  return WINDOWS_UDS.exec(address)?.[1] ?? null;
}

// src/relay/forward-record.ts
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync as readdirSync2,
  readFileSync as readFileSync4,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join as join2 } from "node:path";

// src/pull/state.ts
import { join } from "node:path";
var STATE_MAX_AGE_MS = 2 * 6e4;
var PARTICIPANT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
function pullStateDirs(env, home) {
  const dirs = [env.CLAUDE_PLUGIN_DATA, join(home, ".agentmesh", "run")];
  return [...new Set(dirs.filter((d) => !!d))];
}

// src/relay/pointer.ts
var THREAD_ID = /^thr-[1-9]\d{0,11}$/;
var MESSAGE_ID = /^msg-[0-9A-HJKMNP-TV-Z]{26}$/;
var valid = (re, v) => typeof v === "string" && re.test(v);
function pointerText({ from, threadId, messageId }) {
  if (!valid(PARTICIPANT_ID, from) || !valid(THREAD_ID, threadId) || !valid(MESSAGE_ID, messageId)) {
    return null;
  }
  return `AgentMesh: ${from} answered in ${threadId} (msg ${messageId}). Read it with thread ${threadId} and reply there. Do not reply to this message.`;
}

// src/relay/forward-record.ts
var FORWARD_TTL_MS = 6e5;
var HEX = /^[0-9a-f]{32}$/;
function forwardFile(hex, messageId) {
  return HEX.test(hex) && MESSAGE_ID.test(messageId) ? `fwd-${hex}-${messageId}.json` : null;
}
function candidate(dir, name, hex, now) {
  try {
    const v = JSON.parse(readFileSync4(join2(dir, name), "utf8"));
    const fields = { from: v.from, threadId: v.threadId, messageId: v.messageId };
    const ok = typeof v.expiresAt === "number" && now <= v.expiresAt && // Nothing in the file is trusted: a hand-written far-future expiry must not live forever.
    v.expiresAt - now <= FORWARD_TTL_MS && pointerText(fields) !== null && forwardFile(hex, fields.messageId) === name;
    return ok ? [{ name, fields }] : [];
  } catch {
    return [];
  }
}
function readForwards(dir, hex, now) {
  if (!HEX.test(hex)) return [];
  let names;
  try {
    names = readdirSync2(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith(`fwd-${hex}-`) && n.endsWith(".json")).flatMap((n) => candidate(dir, n, hex, now));
}
var CLAIMED = ".claimed";
function claimForward(dir, name) {
  try {
    closeSync(openSync(join2(dir, `${name}${CLAIMED}`), "wx", 384));
  } catch {
    return false;
  }
  if (!existsSync(join2(dir, name))) return false;
  removeForward(dir, name);
  return true;
}
function removeForward(dir, name) {
  try {
    rmSync(join2(dir, name), { force: true });
  } catch {
  }
}

// src/guard/send.ts
var SEND_DENIED = "mesh window: SendMessage may only forward the reply pointer the plugin pushed (meta forward_to), exactly as pushed, once";
var LIST_AGENTS = "mesh window: ListAgents is refused here; the plugin gives the address to send to";
var forwardReader = (dir) => ({
  read: (hex, now) => readForwards(dir, hex, now),
  claim: (name) => claimForward(dir, name)
});
var KEYS = /* @__PURE__ */ new Set([
  "to",
  "recipient",
  "recipient_kind",
  "message",
  "content",
  "type",
  "summary"
]);
var SUMMARY_MAX = 200;
var DENIED = { kind: "deny", reason: SEND_DENIED };
var shortLabel = (v) => v === void 0 || typeof v === "string" && v.length <= SUMMARY_MAX;
function sendMessage(args, ctx) {
  if (!Object.keys(args).every((k) => KEYS.has(k))) return DENIED;
  const hex = udsHex(args.to, ctx.platform);
  if (hex === null) return DENIED;
  const aliases = args.recipient === args.to && args.type === "message" && (args.recipient_kind === void 0 || typeof args.recipient_kind === "string") && typeof args.message === "string" && args.content === args.message && shortLabel(args.summary);
  if (!aliases || !ctx.forwards) return DENIED;
  const record = ctx.forwards.read(hex, ctx.now ?? Date.now()).find((c) => pointerText(c.fields) === args.message);
  return record && ctx.forwards.claim(record.name) ? { kind: "pass" } : DENIED;
}

// src/guard/decide.ts
var ACTIVATE_TOOL = "mcp__plugin_agentmesh_mesh__activate";
var FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
var PASS = { kind: "pass" };
var deny = (reason) => ({ kind: "deny", reason });
var ask2 = (reason) => ({ kind: "ask", reason });
var UNREADABLE = "mesh window: the guard could not read this tool call, so it is refused";
var NO_FILE = "mesh window: this edit names no file, so it is refused";
var ENTER = "mesh window: stay in this folder; make worktrees with git worktree add .claude/worktrees/mesh-\u2026";
var ISOLATED = "mesh window: subagents run here, without isolation; worktrees are made with git worktree add .claude/worktrees/mesh-\u2026";
var WORKFLOW = "mesh window: workflows need your human's approval here";
var FIXED = /* @__PURE__ */ new Map([
  [ACTIVATE_TOOL, { kind: "stamp" }],
  ["EnterWorktree", deny(ENTER)],
  ["Workflow", ask2(WORKFLOW)],
  ["ListAgents", deny(LIST_AGENTS)]
]);
var isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function edit(args, o) {
  const paths = [args.notebook_path, args.file_path].filter((p) => p !== void 0 && p !== null);
  if (paths.length === 0 || paths.includes("")) return deny(NO_FILE);
  for (const path3 of paths) {
    const target = editTarget(path3, o);
    if ("refused" in target)
      return deny(`mesh window: work only inside a task worktree (${target.refused})`);
  }
  return PASS;
}
function bash(command, cwd, ctx, o) {
  try {
    const d = classifyCommand(command, {
      policy: ctx.policy,
      cwd,
      worktreeOf: (dir) => {
        const w = meshWorktreeOf(dir, o);
        return "refused" in w ? null : w;
      },
      checkoutTop: (dir) => checkoutTop(dir, o),
      remoteRefExists: (top, branch) => remoteRefExists(top, branch, o),
      freeSlot: (top, name) => freeSlot(top, name, o)
    });
    return "ask" in d ? ask2(d.ask) : PASS;
  } catch {
    return ask2(UNLISTED);
  }
}
function decide(input, ctx) {
  if (!ctx.marked) return PASS;
  if (!isObject(input)) return deny(UNREADABLE);
  const { tool_name: tool, tool_input: args, cwd } = input;
  if (typeof tool !== "string" || !isObject(args)) return deny(UNREADABLE);
  const o = { home: ctx.home, platform: ctx.platform };
  if (FILE_TOOLS.includes(tool)) return edit(args, o);
  if (tool === "Bash") return bash(args.command, cwd, ctx, o);
  if (tool === "PowerShell" || tool === "Monitor") {
    return ask2(`mesh window: ${tool} commands need your human's approval here`);
  }
  if (tool === "Agent") return "isolation" in args ? deny(ISOLATED) : PASS;
  if (tool === "SendMessage") return sendMessage(args, ctx);
  return FIXED.get(tool) ?? deny(`mesh window: the guard does not know ${tool}, so it is refused`);
}

// src/guard/io.ts
function readAll(stream, capMs) {
  return new Promise((resolve3, reject) => {
    const chunks = [];
    const done = () => {
      clearTimeout(timer);
      resolve3(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = capMs === null ? void 0 : setTimeout(done, capMs);
    stream.on(
      "data",
      (c) => chunks.push(typeof c === "string" ? Buffer.from(c) : c)
    );
    stream.on("end", done);
    stream.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
function hookOutput(d) {
  if (d.kind === "deny") return { exitCode: 2, stdout: "", stderr: d.reason };
  if (d.kind === "ask") {
    const hookSpecificOutput = {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: d.reason
    };
    return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput }), stderr: "" };
  }
  return { exitCode: 0, stdout: "", stderr: "" };
}

// src/window/guard-stamp.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync5, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
var GUARD_STAMP = "guard-alive.json";
function writeGuardStamp(dir, now, version) {
  mkdirSync2(dir, { recursive: true, mode: 448 });
  const file = join3(dir, GUARD_STAMP);
  const staged = `${file}.${process.pid}.tmp`;
  writeFileSync2(staged, JSON.stringify({ at: now.toISOString(), version }), { mode: 384 });
  renameSync2(staged, file);
}

// src/guard.ts
var UNMARKED_STDIN_MS = 1e3;
var FAILED = "mesh window: the guard failed on this call, so it is refused";
function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
async function main(marked2) {
  const text = await readAll(process.stdin, marked2 ? null : UNMARKED_STDIN_MS);
  process.stdin.destroy();
  if (!marked2) return 0;
  const env = process.env;
  const home = homedir();
  const platform = process.platform;
  const { policy } = readMarker(env, home, platform);
  const dir = pullStateDirs(env, home)[0] ?? ".";
  const forwards = forwardReader(dir);
  const decision = decide(parse(text), { marked: marked2, policy, home, platform, forwards });
  if (decision.kind === "stamp") writeGuardStamp(dir, /* @__PURE__ */ new Date(), VERSION);
  const out = hookOutput(decision);
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  return out.exitCode;
}
var marked = !!process.env[MESH_WINDOW_ENV];
main(marked).then(
  (code2) => {
    process.exitCode = code2;
  },
  () => {
    if (marked) process.stderr.write(FAILED);
    process.exitCode = marked ? 2 : 0;
  }
);
