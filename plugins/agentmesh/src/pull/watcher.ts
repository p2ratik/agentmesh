import { rmSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@agentmesh/common';
import type { HubClient } from '../hub';
import { type LocalSession, localSessionFile, localSessionRecord } from '../relay/local-session';
import type { ActivationState } from '../tools/activation';
import { type Heartbeat, heartbeatFile } from '../window/heartbeat';
import { type PullState, pullStateFile } from './state';

/** How often an active pull session refreshes its state file (the hook ignores files past 2 min). */
export const POLL_MS = 30_000;

export interface PullWatcherDeps {
  hub: Pick<HubClient, 'call' | 'sessionId'>;
  activation: ActivationState;
  agentId: string;
  prefix: string;
  /** Where the state file goes (`pullStateDirs(...)[0]`). */
  dir: string;
  projectDir: string;
  /** Whether this process is the verified mesh window; the heartbeat says so. */
  meshWindow: boolean;
  /**
   * Whether AGENTMESH_MESH_WINDOW marks this process, verified or not (the hooks' "marked"). A
   * marked session keeps no private record, so the window never forwards a pointer to it.
   */
  marked: boolean;
  /** This session's messaging address: local data, never logged or sent to the hub. */
  uds: string | null;
  /** The Claude Code process (the prompt hook's `CLAUDE_PID`). */
  claudePid: number;
  /** Its current conversation, once the SessionStart record named it. */
  claudeSessionId: () => string | null;
  /** False when the human set AGENTMESH_RELAY=off. */
  relay: boolean;
  logger: Logger;
}

/**
 * Keeps one local file current for the hooks. An active pull session polls `inbox.peek` and
 * writes the counts (ADR 0008): nothing is pushed in pull mode, so this is how the user's next
 * prompt learns about new work. An active push session (not renewing) keeps a heartbeat, with no
 * hub call, so the SessionStart hook can tell a window is listening; the mesh window's carries
 * its address. An inactive private session that has used the mesh keeps its record (the peek
 * counts and its address) for the reply note and the window's relay. Otherwise no file.
 */
export class PullWatcher {
  readonly #deps: PullWatcherDeps;
  #file: string | null = null;
  #used = false;
  #running: Promise<void> | null = null;
  #again = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(deps: PullWatcherDeps) {
    this.#deps = deps;
  }

  start(): void {
    this.#timer = setInterval(() => void this.refresh(), POLL_MS);
    this.#timer.unref();
  }

  /** A mesh tool ran: from now on, while inactive, this session keeps its private record. */
  markUsed(): void {
    this.#used = true;
  }

  /** One refresh at a time; a call during one runs once more after it, so no change is missed. */
  refresh(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#refresh().finally(() => {
      this.#running = null;
      if (!this.#again) return;
      this.#again = false;
      void this.refresh();
    });
    return this.#running;
  }

  /** Removes this process's file. Synchronous, so it also runs on the way out. */
  clear(): void {
    if (this.#file) {
      try {
        rmSync(this.#file, { force: true });
      } catch (err) {
        this.#deps.logger.warn({ err }, 'could not remove a state file');
      }
    }
    this.#file = null;
  }

  /** Writes this process's one file, removing the previous one when the name changes. */
  async #writeFile(file: string, value: PullState | Heartbeat | LocalSession): Promise<void> {
    if (this.#file !== file) this.clear();
    await mkdir(this.#deps.dir, { recursive: true, mode: 0o700 });
    // Write then rename, so the hook never reads half a file.
    await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    this.#file = file;
  }

  async #heartbeat(sessionId: string): Promise<void> {
    const { agentId, prefix, dir, meshWindow, uds } = this.#deps;
    const beat: Heartbeat = {
      agentId,
      prefix,
      sessionId,
      meshWindow,
      uds: meshWindow ? uds : null,
      updatedAt: new Date().toISOString(),
    };
    await this.#writeFile(join(dir, heartbeatFile(prefix, agentId, sessionId)), beat);
  }

  /** An inactive private session's record, with the threads it started that have unread replies. */
  async #record(hubSessionId: string): Promise<void> {
    const { hub, activation, agentId, prefix, dir } = this.#deps;
    const name = localSessionFile(prefix, agentId, hubSessionId);
    if (!name) return this.clear();
    const peek = await hub.call('inbox.peek', {});
    // Activated, or a new hub session, while the call was out: the next refresh handles it.
    if (activation.lastDescription !== null || activation.pull) return;
    if (hub.sessionId !== hubSessionId) return;
    const base = { ...this.#deps, hubSessionId, claudeSessionId: this.#deps.claudeSessionId() };
    const record = localSessionRecord(base, peek, new Date().toISOString());
    await this.#writeFile(join(dir, name), record);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.clear();
  }

  async #refresh(): Promise<void> {
    const { hub, activation, logger, meshWindow, marked } = this.#deps;
    const sessionId = hub.sessionId;
    if (!sessionId) return this.clear();
    const inactive = activation.lastDescription === null && !activation.pull;
    if (inactive && !meshWindow && !marked && this.#used) {
      return this.#record(sessionId).catch((err) =>
        logger.warn({ err }, 'could not refresh the local session record'),
      );
    }
    if (!activation.pull) {
      const listening = activation.lastDescription !== null && activation.renewedFrom === null;
      if (!listening) return this.clear();
      try {
        return await this.#heartbeat(sessionId);
      } catch (err) {
        logger.warn({ err }, 'could not write the heartbeat');
        return;
      }
    }
    try {
      const peek = await hub.call('inbox.peek', {});
      // Deactivated, or a new hub session, while the call was out: the next refresh handles it.
      if (!activation.pull || hub.sessionId !== sessionId) return;
      const { agentId, prefix, dir, projectDir } = this.#deps;
      const state: PullState = {
        agentId,
        sessionId,
        projectDir,
        // Field by field: counts and ids only, whatever else a hub might send.
        threads: peek.threads,
        actions: peek.actions,
        from: peek.from,
        external: peek.external,
        updatedAt: new Date().toISOString(),
      };
      await this.#writeFile(join(dir, pullStateFile(prefix, agentId, sessionId)), state);
    } catch (err) {
      logger.warn({ err }, 'could not refresh the pull state');
    }
  }
}
