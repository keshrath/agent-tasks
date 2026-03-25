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

const SCHEMA_VERSION = 2;

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
  if (currentVersion < 2) migrateV2(db);

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

function migrateV2(db: Database.Database): void {
  // -- Subtask support
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'parent_id')) {
    db.exec(
      `ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE`,
    );
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)`);

  // -- Artifact versioning
  const artCols = db.prepare(`PRAGMA table_info(task_artifacts)`).all() as { name: string }[];
  if (!artCols.some((c) => c.name === 'version')) {
    db.exec(`ALTER TABLE task_artifacts ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
  }
  if (!artCols.some((c) => c.name === 'previous_id')) {
    db.exec(
      `ALTER TABLE task_artifacts ADD COLUMN previous_id INTEGER REFERENCES task_artifacts(id)`,
    );
  }

  // -- Comments with threading
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      parent_comment_id INTEGER REFERENCES task_comments(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at);
  `);

  // -- Collaborators
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_collaborators (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'collaborator',
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_collaborators_agent ON task_collaborators(agent_id);
  `);

  // -- Approvals
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewer TEXT,
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      comment TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_task ON task_approvals(task_id, stage);
    CREATE INDEX IF NOT EXISTS idx_approvals_reviewer ON task_approvals(reviewer, status);
  `);

  // -- Pipeline config extensions
  const pcCols = db.prepare(`PRAGMA table_info(pipeline_config)`).all() as { name: string }[];
  if (!pcCols.some((c) => c.name === 'approval_config')) {
    db.exec(`ALTER TABLE pipeline_config ADD COLUMN approval_config TEXT`);
  }
  if (!pcCols.some((c) => c.name === 'assignment_config')) {
    db.exec(`ALTER TABLE pipeline_config ADD COLUMN assignment_config TEXT`);
  }

  // -- FTS5 on tasks
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
      title, description,
      content=tasks, content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS tasks_fts_insert AFTER INSERT ON tasks BEGIN
      INSERT INTO tasks_fts(rowid, title, description) VALUES (new.id, new.title, COALESCE(new.description, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS tasks_fts_update AFTER UPDATE OF title, description ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES ('delete', old.id, old.title, COALESCE(old.description, ''));
      INSERT INTO tasks_fts(rowid, title, description) VALUES (new.id, new.title, COALESCE(new.description, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS tasks_fts_delete AFTER DELETE ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES ('delete', old.id, old.title, COALESCE(old.description, ''));
    END;
  `);

  // -- Backfill FTS for existing tasks
  const existing = db.prepare(`SELECT id, title, description FROM tasks`).all() as {
    id: number;
    title: string;
    description: string | null;
  }[];
  const ftsInsert = db.prepare(
    `INSERT OR IGNORE INTO tasks_fts(rowid, title, description) VALUES (?, ?, ?)`,
  );
  for (const t of existing) {
    ftsInsert.run(t.id, t.title, t.description ?? '');
  }
}
