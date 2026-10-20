import { redactSecrets } from '@agentmesh/common';
import type { PlanContribution, PlanRound } from '@agentmesh/protocol';

export interface QuorumInput {
  participants: readonly string[];
  /** Participants online right now. */
  online: ReadonlySet<string>;
  /** Participants who contributed to the current round. */
  contributed: ReadonlySet<string>;
  /** Share of online participants needed to end a round early (0..1). */
  quorum: number;
}

/**
 * A round may end before its deadline once everyone contributed, or once the
 * configured share of *online* participants did (offline agents still get
 * the compiled digest when they come back). At least one contribution is needed.
 */
export function roundComplete(input: QuorumInput): boolean {
  const contributed = input.participants.filter((p) => input.contributed.has(p));
  if (contributed.length === 0) return false;
  if (contributed.length === input.participants.length) return true;
  const online = input.participants.filter((p) => input.online.has(p));
  if (online.length === 0) return false;
  const onlineContributed = online.filter((p) => input.contributed.has(p)).length;
  return onlineContributed >= Math.max(1, Math.ceil(input.quorum * online.length));
}

/** The participant best placed to take over facilitation: most contributions, online. */
export function pickNewFacilitator(
  participants: readonly string[],
  current: string,
  online: ReadonlySet<string>,
  contributions: readonly PlanContribution[],
): string | null {
  const counts = new Map<string, number>();
  for (const c of contributions) counts.set(c.participant, (counts.get(c.participant) ?? 0) + 1);
  const candidates = participants.filter((p) => p !== current && online.has(p));
  candidates.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  return candidates[0] ?? null;
}

/**
 * Every contribution so far, grouped by round and participant, as markdown.
 * Over `maxChars`, each contribution is cut proportionally and marked, so
 * agents know to call `plan_get` for the full text. Each contribution is
 * redacted before it is cut: a cut token no longer matches.
 */
export function compileContributions(
  rounds: readonly PlanRound[],
  contributions: readonly PlanContribution[],
  name: (participantId: string) => string,
  maxChars = 12_000,
): string {
  if (contributions.length === 0) return '_No contributions yet._';
  const total = contributions.reduce((n, c) => n + c.body.length, 0);
  const budget = Math.max(200, Math.floor(maxChars / contributions.length));
  const clip = (raw: string) => {
    const body = redactSecrets(raw);
    return total <= maxChars || body.length <= budget
      ? body
      : `${body.slice(0, budget)}\n… _(truncated — call plan_get for the full text)_`;
  };
  const sections: string[] = [];
  for (const round of rounds) {
    const items = contributions.filter((c) => c.round === round.id);
    if (items.length === 0) continue;
    const entries = items.map(
      (c) => `**${name(c.participant)}** (${c.participant}):\n${clip(c.body)}`,
    );
    sections.push(`### ${round.title}\n\n${entries.join('\n\n')}`);
  }
  return sections.join('\n\n');
}
