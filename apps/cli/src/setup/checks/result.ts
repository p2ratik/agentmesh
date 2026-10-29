/** One line of the setup proof (spec §7): ✓ or ✗ `label`, and for a ✗ what to do next. */
export interface CheckResult {
  ok: boolean;
  label: string;
  detail?: string;
}
