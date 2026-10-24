import type { CheckResult } from '../checks/result';

/** The setup proof (spec §7): a headline, then ✓ or ✗ per check, each ✗ with what to do. Pure. */
export function renderChecklist(team: string, results: CheckResult[]): string {
  const problems = results.filter((r) => !r.ok).length;
  const headline =
    problems === 0
      ? `AgentMesh is live for ${team}`
      : `AgentMesh for ${team}: ${problems} problem${problems === 1 ? '' : 's'}`;
  const lines = results.flatMap((r) => {
    if (r.ok) return [` ✓ ${r.label}`];
    return [` ✗ ${r.label}`, ...(r.detail ? [`   → ${r.detail.replaceAll('\n', '\n     ')}`] : [])];
  });
  return [headline, ...lines].join('\n');
}
