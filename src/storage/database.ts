// =============================================================================
// agent-tasks — Storage layer
//
// Thin wrapper around better-sqlite3 with schema management and migrations.
// Provides a simplified query interface used by domain services.
// =============================================================================

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

export interface DbOptions {
  path?: string;
  verbose?: boolean;
}

export interface Db {
  readonly raw: Database.Database;
  run(sql: string, params?: unknown[]): Database.RunResult;
  queryAll<T>(sql: string, params?: unknown[]): T[];
  queryOne<T>(sql: string, params?: unknown[]): T | null;
  transaction<T>(fn: () => T): T;
  close(): void;
}

const SCHEMA_VERSION = 1;

export function createDb(options: DbOptions = {}): Db {
  const dbPath = resolveDbPath(options.path);
  const raw = new Database(dbPath, {
    verbose: options.verbose ? (msg) => process.stderr.write(`[sql] ${msg}\n`) : undefined,
  });

  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');

  applySchema(raw);

  return {
    raw,

    run(sql: string, params?: unknown[]): Database.RunResult {
      const stmt = raw.prepare(sql);
      return params?.length ? stmt.run(...params) : stmt.run();
    },

    queryAll<T>(sql: string, params?: unknown[]): T[] {
      const stmt = raw.prepare(sql);
      return (params?.length ? stmt.all(...params) : stmt.all()) as T[];
    },

    queryOne<T>(sql: string, params?: unknown[]): T | null {
      const stmt = raw.prepare(sql);
      const row = params?.length ? stmt.get(...params) : stmt.get();
      return (row as T) ?? null;
    },

    transaction<T>(fn: () => T): T {
      return raw.transaction(fn)();
    },

    close(): void {
      try {
        raw.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function resolveDbPath(path?: string): string {
  if (path === ':memory:') return path;
  if (path) return path;
  const envPath = process.env.AGENT_TASKS_DB;
  if (envPath) return envPath;
  const dir = join(homedir(), '.agent-tasks');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'agent-tasks.db');
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const row = db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  if (currentVersion < 1) migrateV1(db);

  db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)`).run(
    String(SCHEMA_VERSION),
  );
}

function migrateV1(db: Database.Database): void {
  db.exec(`
    -- Tasks
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      created_by TEXT NOT NULL,
      assigned_to TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      stage TEXT NOT NULL DEFAULT 'backlog',
      priority INTEGER NOT NULL DEFAULT 0,
      project TEXT,
      tags TEXT,
      result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_stage ON tasks(stage, priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    -- Dependencies (with foreign keys)
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on)
    );

    -- Artifacts (with foreign key)
    CREATE TABLE IF NOT EXISTS task_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_artifacts_task ON task_artifacts(task_id, stage);

    -- Pipeline configuration per project
    CREATE TABLE IF NOT EXISTS pipeline_config (
      project TEXT PRIMARY KEY,
      stages TEXT NOT NULL DEFAULT '["backlog","spec","plan","implement","test","review","done","cancelled"]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
