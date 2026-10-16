import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type SqlParams = Record<string, SQLInputValue> | SQLInputValue[];

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/**
 * Small synchronous wrapper over `node:sqlite`. Statements are cached;
 * named parameters are written `$name` in SQL and passed as `{ name }`.
 * Transactions nest via savepoints.
 */
export class Db {
  readonly raw: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, params: SqlParams = []): RunResult {
    const stmt = this.#prepare(sql);
    const result = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T>(sql: string, params: SqlParams = []): T | undefined {
    const stmt = this.#prepare(sql);
    return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined;
  }

  all<T>(sql: string, params: SqlParams = []): T[] {
    const stmt = this.#prepare(sql);
    return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[];
  }

  /** Runs `fn` atomically. Nested calls become savepoints. Never pass an async function. */
  transaction<T>(fn: () => T): T {
    const savepoint = `sp_${this.#depth}`;
    this.raw.exec(this.#depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.#depth += 1;
    try {
      const result = fn();
      if (result instanceof Promise)
        throw new Error('Db.transaction does not accept async functions');
      this.#depth -= 1;
      this.raw.exec(this.#depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.#depth -= 1;
      this.raw.exec(
        this.#depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`,
      );
      throw error;
    }
  }

  close(): void {
    this.#statements.clear();
    this.raw.close();
  }

  #prepare(sql: string): StatementSync {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }
}

/** JSON column helpers. */
export const toJson = (value: unknown): string => JSON.stringify(value ?? null);

export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
