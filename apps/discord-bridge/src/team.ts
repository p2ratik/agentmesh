import { ConfigIndex, type MeshConfig, withMembers } from '@agentmesh/config';
import type { MemberRecord } from '@agentmesh/protocol';
import type { MeshRpc } from './rpc';

/**
 * The bridge's view of the team: mesh.yaml plus members who joined by invite.
 * Rebuilt from the hub's `enrollment.list` at startup and on every member
 * event, so a new member can use slash commands without a bridge restart.
 */
export class TeamIndex {
  readonly #yaml: MeshConfig;
  #current: ConfigIndex;
  #active: readonly MemberRecord[] = [];

  constructor(yaml: MeshConfig) {
    this.#yaml = yaml;
    this.#current = new ConfigIndex(yaml);
  }

  /** Read on every use; the index is replaced when members join or leave. */
  get current(): ConfigIndex {
    return this.#current;
  }

  /** Active members who joined by invite: the only people `/mesh remove` can remove. */
  get members(): readonly MemberRecord[] {
    return this.#active;
  }

  /** Fetches the member list and swaps the index. Throws if the hub does not answer. */
  async refresh(rpc: MeshRpc): Promise<number> {
    const { members } = await rpc.call('enrollment.list', {});
    this.#current = new ConfigIndex(withMembers(this.#yaml, members).config);
    this.#active = members.filter((m) => m.status === 'active');
    return this.#active.length;
  }
}
