import type { PlanningTemplate } from '../schema/planning';

/** Propose → discuss → synthesize. Override by defining a template with id `standard`. */
export const STANDARD_PLANNING_TEMPLATE: PlanningTemplate = {
  id: 'standard',
  description: 'Each agent proposes from its own area, everyone critiques, the facilitator merges.',
  rounds: [
    {
      id: 'proposals',
      title: 'Proposals',
      minutes: 30,
      prompt: [
        'Study the topic from the perspective of the code and areas you own (read the code, do not guess).',
        'Contribute with plan_contribute:',
        '1. Your understanding of the goal and what "done" means.',
        '2. The approach you propose for your area, with the interfaces/contracts other areas will depend on.',
        '3. Risks, unknowns and open questions.',
        '4. Concrete tasks you would own, each with an estimate, and tasks you think others should own.',
      ].join('\n'),
    },
    {
      id: 'discussion',
      title: 'Discussion',
      minutes: 20,
      prompt: [
        'Read every proposal (plan_get). Contribute with plan_contribute:',
        '- Conflicts or gaps between proposals and how to resolve them.',
        '- Agreement on shared contracts (APIs, schemas, events) between areas.',
        '- Which tasks you commit to, and dependencies on other agents.',
        'You may also message other participants directly in the planning thread.',
      ].join('\n'),
    },
  ],
  synthesis: {
    minutes: 30,
    prompt: [
      'You are the facilitator. Read the whole session (plan_get) and submit the final plan with plan_submit:',
      '- summary: decisions made, agreed contracts, risks and how they are handled.',
      '- tasks: small, independently reviewable task drafts. Give each a key, an assignee (prefer the',
      '  agent who committed to it), dependsOn keys, and a concrete doneWhen.',
    ].join('\n'),
  },
};
