import { z } from 'zod';
import type { CheckResult } from './result';

/** The fields doctor reads from a `docker compose ps --format json` row. */
const Container = z.object({
  Service: z.string(),
  State: z.string(),
  Health: z.string().default(''),
});

const SERVICES = ['nats', 'hub', 'discord-bridge'] as const;

function parseRows(text: string): Array<z.infer<typeof Container>> | null {
  const trimmed = text.trim();
  try {
    // Compose before 2.21 prints one JSON array instead of one object per line.
    const raw = trimmed.startsWith('[')
      ? JSON.parse(trimmed)
      : trimmed
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
    const rows = z.array(Container).safeParse(raw);
    return rows.success ? rows.data : null;
  } catch {
    return null;
  }
}

/**
 * Judges `docker compose ps --format json`: nats, hub and discord-bridge must be running and
 * the hub healthy. One line when all are, else one failing line per container. Pure.
 */
export function classifyContainers(psJsonLines: string): CheckResult[] {
  const rows = parseRows(psJsonLines);
  if (!rows) {
    return [
      {
        ok: false,
        label: 'docker compose ps printed something doctor cannot read',
        detail: 'Update Docker Compose to 2.21 or later and run doctor again.',
      },
    ];
  }
  const problems = SERVICES.flatMap((service): CheckResult[] => {
    const row = rows.find((r) => r.Service === service);
    const logs = `see \`docker compose logs ${service}\` in the deploy folder.`;
    if (!row) {
      return [
        { ok: false, label: `${service} is not running`, detail: `Run setup deploy, or ${logs}` },
      ];
    }
    if (row.State !== 'running') {
      return [
        { ok: false, label: `${service} is ${row.State}`, detail: `It should be running: ${logs}` },
      ];
    }
    if (service === 'hub' && row.Health !== 'healthy') {
      const health = row.Health || 'not reporting its health';
      return [
        {
          ok: false,
          label: `hub is ${health}`,
          detail: `Wait a minute and run doctor again. If it stays ${health}, ${logs}`,
        },
      ];
    }
    return [];
  });
  return problems.length > 0
    ? problems
    : [{ ok: true, label: 'nats, hub (healthy) and discord-bridge are running' }];
}
