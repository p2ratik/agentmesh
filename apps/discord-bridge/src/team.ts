import { type RetryOptions, retry } from '@agentmesh/common';
import { ConfigIndex, type MeshConfig, withMembers } from '@agentmesh/config';
import type { MemberRecord, OpenInvite } from '@agentmesh/protocol';
import type { MeshRpc } from './rpc';

/** What `/mesh remove` and `/mesh uninvite` autocomplete from. */
export interface Enrolled {
  members: readonly MemberRecord[];
  invites: readonly OpenInvite[];
}

/**
 * The bridge's view of the team: mesh.yaml plus members who joined by invite.
 * Rebuilt from the hub's `enrollment.list` at startup (until the hub answers),
 * on every member event and after `/mesh invite` or `/mesh uninvite`, so a new
 * member can use slash commands without a bridge restart.
 */
export class TeamIndex {
  readonly #yaml: MeshConfig;
  #current: ConfigIndex;
  #active: readonly MemberRecord[] = [];
  #invites: readonly OpenInvite[] = [];

  constructor(yaml: MeshConfig) {
    this.#yaml = yaml;
    this.#current = new ConfigIndex(yaml);
  }

  /** Read on every use; the index is replaced when members join or leave. */
  get current(): ConfigIndex {
    return this.#current;
  }

  /**
   * Active invited members (the only people `/mesh remove` can remove) and
   * the invites still open at `now`: the last refresh, minus expiries.
   */
  enrolled(now: Date): Enrolled {
    const at = now.getTime();
    return {
      members: this.#active,
      invites: this.#invites.filter((i) => Date.parse(i.expiresAt) > at),
    };
  }

  /** Fetches the member list and swaps the index. Throws if the hub does not answer. */
  async refresh(rpc: MeshRpc): Promise<number> {
    const { members, invites } = await rpc.call('enrollment.list', {});
    this.#current = new ConfigIndex(withMembers(this.#yaml, members).config);
    this.#active = members.filter((m) => m.status === 'active');
    this.#invites = invites;
    return this.#active.length;
  }

  /**
   * The startup load: refreshes with backoff until the hub answers, since the hub may
   * start after the bridge. Until then only mesh.yaml members can use the bridge.
   */
  load(rpc: MeshRpc, options: RetryOptions = {}): Promise<number> {
    return retry(() => this.refresh(rpc), { attempts: Number.POSITIVE_INFINITY, ...options });
  }
}
