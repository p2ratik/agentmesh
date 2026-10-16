/** Buttons on plan-approval posts encode their action as `plan:<action>:<planId>`. */
export type PlanButtonAction = 'approve' | 'cancel';

const PLAN_BUTTON = /^plan:(approve|cancel):([A-Za-z0-9_-]{1,80})$/;

export function planButtonId(action: PlanButtonAction, planId: string): string {
  return `plan:${action}:${planId}`;
}

/** Parses a button custom id; null for anything this bridge did not create. */
export function parsePlanButtonId(
  customId: string,
): { action: PlanButtonAction; planId: string } | null {
  const match = PLAN_BUTTON.exec(customId);
  if (!match?.[1] || !match[2]) return null;
  return { action: match[1] as PlanButtonAction, planId: match[2] };
}
