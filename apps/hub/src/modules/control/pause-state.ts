import { z } from 'zod';
import { type Db, fromJson, toJson } from '../../db/database';

/** The kill-switch state, stored as JSON under the `paused` settings key. */
export const PauseState = z.object({
  paused: z.boolean(),
  reason: z.string().nullable(),
  by: z.string(),
  at: z.string(),
});
export type PauseState = z.infer<typeof PauseState>;

const KEY = 'paused';

/** Reads the pause state; a missing or unreadable row means "not paused". */
export function readPauseState(db: Db): PauseState | null {
  const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = $key', {
    key: KEY,
  });
  const parsed = PauseState.safeParse(fromJson<unknown>(row?.value, null));
  return parsed.success ? parsed.data : null;
}

export function writePauseState(db: Db, state: PauseState): void {
  db.run(
    `INSERT INTO settings (key, value) VALUES ($key, $value)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    { key: KEY, value: toJson(state) },
  );
}
