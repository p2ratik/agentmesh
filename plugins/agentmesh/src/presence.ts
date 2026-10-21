import type { Logger } from '@agentmesh/common';
import { subjects } from '@agentmesh/protocol';
import { type GitInfo, readGitInfo } from './git';
import type { HubClient } from './hub';

const GIT_REFRESH_MS = 60_000;

/**
 * Heartbeats `{prefix}.presence.{agent}` with the repo and branch this
 * session works in, so teammates see who is online and where, and with the
 * hub session id, which keeps that session alive.
 */
export class Presence {
  readonly #hub: HubClient;
  readonly #logger: Logger;
  readonly #cwd: string;
  #git: GitInfo = {};
  #timers: NodeJS.Timeout[] = [];

  constructor(hub: HubClient, logger: Logger, cwd: string) {
    this.#hub = hub;
    this.#logger = logger;
    this.#cwd = cwd;
  }

  get git(): GitInfo {
    return this.#git;
  }

  async refreshGit(): Promise<GitInfo> {
    this.#git = await readGitInfo(this.#cwd);
    return this.#git;
  }

  start(): void {
    const beat = () => {
      const { connection: nc, sessionId } = this.#hub;
      if (!nc) return;
      try {
        nc.publish(
          subjects(this.#hub.config.prefix).presence(this.#hub.config.agentId),
          JSON.stringify({ ...this.#git, ...(sessionId ? { session: sessionId } : {}) }),
        );
      } catch (err) {
        this.#logger.debug({ err }, 'heartbeat failed');
      }
    };
    beat();
    this.#timers.push(setInterval(beat, this.#hub.config.heartbeatSeconds * 1000));
    this.#timers.push(setInterval(() => void this.refreshGit(), GIT_REFRESH_MS));
    for (const timer of this.#timers) timer.unref();
  }

  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
  }
}
