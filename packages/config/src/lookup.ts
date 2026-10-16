import type { ParticipantKind, ParticipantRef } from '@agentmesh/protocol';
import type { MeshConfig } from './schema/mesh';
import type { PlanningTemplate } from './schema/planning';
import type { AgentConfig, AreaConfig, HumanConfig, ServiceConfig } from './schema/team';
import type { WorkflowConfig } from './schema/workflow';

/** Fast lookups over a validated config. Build once, share everywhere. */
export class ConfigIndex {
  readonly config: MeshConfig;
  readonly #humans = new Map<string, HumanConfig>();
  readonly #agents = new Map<string, AgentConfig>();
  readonly #services = new Map<string, ServiceConfig>();
  readonly #areas = new Map<string, AreaConfig>();
  readonly #workflows = new Map<string, WorkflowConfig>();
  readonly #templates = new Map<string, PlanningTemplate>();
  readonly #humansByDiscord = new Map<string, HumanConfig>();

  constructor(config: MeshConfig) {
    this.config = config;
    for (const h of config.humans) {
      this.#humans.set(h.id, h);
      if (h.discordUserId) this.#humansByDiscord.set(h.discordUserId, h);
    }
    for (const a of config.agents) this.#agents.set(a.id, a);
    for (const s of config.services) this.#services.set(s.id, s);
    for (const a of config.areas) this.#areas.set(a.id, a);
    for (const w of config.workflows) this.#workflows.set(w.id, w);
    for (const t of config.planning.templates) this.#templates.set(t.id, t);
  }

  human = (id: string) => this.#humans.get(id);
  agent = (id: string) => this.#agents.get(id);
  service = (id: string) => this.#services.get(id);
  area = (id: string) => this.#areas.get(id);
  workflow = (id: string) => this.#workflows.get(id);
  planningTemplate = (id: string) => this.#templates.get(id);
  humanByDiscordId = (discordUserId: string) => this.#humansByDiscord.get(discordUserId);

  agents(): AgentConfig[] {
    return [...this.#agents.values()];
  }

  humans(): HumanConfig[] {
    return [...this.#humans.values()];
  }

  kindOf(id: string): ParticipantKind | undefined {
    if (this.#agents.has(id)) return 'agent';
    if (this.#humans.has(id)) return 'human';
    if (this.#services.has(id)) return 'service';
    return undefined;
  }

  displayName(id: string): string {
    const agent = this.#agents.get(id);
    if (agent)
      return (
        agent.displayName ?? `${this.#humans.get(agent.owner)?.displayName ?? agent.owner}'s agent`
      );
    return this.#humans.get(id)?.displayName ?? this.#services.get(id)?.displayName ?? id;
  }

  ref(id: string): ParticipantRef | undefined {
    const kind = this.kindOf(id);
    return kind ? { id, kind, displayName: this.displayName(id) } : undefined;
  }

  agentsOwnedBy(humanId: string): AgentConfig[] {
    return this.agents().filter((a) => a.owner === humanId);
  }

  /** The agent that represents a human by default (their first configured agent). */
  primaryAgentOf(humanId: string): AgentConfig | undefined {
    return this.agentsOwnedBy(humanId)[0];
  }

  hasRole(humanId: string, role: string): boolean {
    return this.#humans.get(humanId)?.roles.includes(role) ?? false;
  }

  areasForRepo(repo: string): AreaConfig[] {
    const needle = repo.toLowerCase();
    return this.config.areas.filter((a) => a.repos.some((r) => r.toLowerCase() === needle));
  }

  areasOwnedBy(agentId: string): AreaConfig[] {
    return this.config.areas.filter((a) => a.owners.includes(agentId));
  }
}

/** Fills a branch template such as `agent/{owner}/{task}-{slug}`. */
export function renderBranchName(
  template: string,
  values: { owner: string; agent: string; task: string; slug: string },
): string {
  return template.replace(
    /\{(owner|agent|task|slug)\}/g,
    (_m, key: keyof typeof values) => values[key],
  );
}
