import { rmSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@agentmesh/common';
import type { HubClient } from '../hub';
import type { ActivationState } from '../tools/activation';
import { type Heartbeat, heartbeatFile } from '../window/heartbeat';
import { type PullState, pullStateFile } from './state';

/** How often an active pull session refreshes its state file (the hook ignores files past 2 min). */
const POLL_MS = 30_000;

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
  logger: Logger;
}

/**
 * Keeps a pull session's state file current: while the session is active in
 * pull mode it polls `inbox.peek` and writes the counts for the prompt hook;
 * otherwise it removes the file. An active push session (not renewing) also keeps
 * a heartbeat file, with no hub call, so the SessionStart hook can tell a window is listening. Nothing is pushed in pull mode, so this is
 * how the user's next prompt learns about new work (ADR 0008).
 */
export class PullWatcher {
  readonly #deps: PullWatcherDeps;
  #file: string | null = null;
  #beat: string | null = null;
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

  /** Removes this process's state file. Synchronous, so it also runs on the way out. */
  clear(): void {
    for (const file of [this.#file, this.#beat]) {
      if (!file) continue;
      try {
        rmSync(file, { force: true });
      } catch (err) {
        this.#deps.logger.warn({ err }, 'could not remove a state file');
      }
    }
    this.#file = null;
    this.#beat = null;
  }

  async #writeFile(file: string, value: PullState | Heartbeat): Promise<void> {
    await mkdir(this.#deps.dir, { recursive: true, mode: 0o700 });
    // Write then rename, so the hook never reads half a file.
    await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  async #heartbeat(sessionId: string): Promise<void> {
    const { agentId, prefix, dir, meshWindow } = this.#deps;
    const file = join(dir, heartbeatFile(prefix, agentId, sessionId));
    if (this.#beat !== file) this.clear();
    const beat: Heartbeat = { agentId, sessionId, meshWindow, updatedAt: new Date().toISOString() };
    await this.#writeFile(file, beat);
    this.#beat = file;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.clear();
  }

  async #refresh(): Promise<void> {
    const { hub, activation, logger } = this.#deps;
    const sessionId = hub.sessionId;
    if (!sessionId) return this.clear();
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
      const file = join(dir, pullStateFile(prefix, agentId, sessionId));
      if (this.#file !== file) this.clear();
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
      await this.#writeFile(file, state);
      this.#file = file;
    } catch (err) {
      logger.warn({ err }, 'could not refresh the pull state');
    }
  }
}
