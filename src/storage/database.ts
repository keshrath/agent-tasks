// =============================================================================
// agent-tasks — Storage layer
//
// better-sqlite3 with WAL pragmas. The DB path comes from options /
// AGENT_TASKS_DB env / default ~/.agent-tasks/agent-tasks.db; the schema is an
// ordered list of migrations whose version is kept in _meta.schema_version.
// =============================================================================

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

export interface Db {
  readonly raw: Database.Database;
  run(sql: string, params?: unknown[]): Database.RunResult;
  queryAll<T>(sql: string, params?: unknown[]): T[];
  queryOne<T>(sql: string, params?: unknown[]): T | null;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface DbOptions {
  path?: string;
  verbose?: boolean;
}

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

export function createDb(options: DbOptions = {}): Db {
  const raw = new Database(resolveDbPath(options.path), {
    verbose: options.verbose ? (msg) => process.stderr.write(`[sql] ${msg}\n`) : undefined,
  });
  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');
  migrate(raw);

  return {
    raw,
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    queryAll: <T>(sql: string, params: unknown[] = []) => raw.prepare(sql).all(...params) as T[],
    queryOne: <T>(sql: string, params: unknown[] = []) =>
      (raw.prepare(sql).get(...params) as T | undefined) ?? null,
    transaction: <T>(fn: () => T) => raw.transaction(fn)(),
    close() {
      if (raw.open) raw.close();
    },
  };
}

/** The schema version this DB is at (0 for a fresh file). */
export function schemaVersion(raw: Database.Database): number {
  raw.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = raw.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

/** Applies every migration newer than the DB's version, in one transaction. */
function migrate(raw: Database.Database): void {
  const from = schemaVersion(raw);
  raw.transaction(() => {
    for (const m of migrations) {
      if (m.version <= from) continue;
      m.up(raw);
      raw
        .prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)`)
        .run(String(m.version));
    }
  })();
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

// ---------------------------------------------------------------------------
// Migrations — in version order; add a new one, never edit an old one
// ---------------------------------------------------------------------------

const migrations: Migration[] = [
  {
    version: 1,
    up: (db: Database.Database) => {
      db.exec(`
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

        CREATE TABLE IF NOT EXISTS task_dependencies (
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          depends_on INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, depends_on)
        );

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

        CREATE TABLE IF NOT EXISTS pipeline_config (
          project TEXT PRIMARY KEY,
          stages TEXT NOT NULL DEFAULT '["backlog","spec","plan","implement","test","review","done","cancelled"]',
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 2,
    up: (db: Database.Database) => {
      const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
      if (!cols.some((c) => c.name === 'parent_id')) {
        db.exec(
          `ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE`,
        );
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)`);

      const artCols = db.prepare(`PRAGMA table_info(task_artifacts)`).all() as { name: string }[];
      if (!artCols.some((c) => c.name === 'version')) {
        db.exec(`ALTER TABLE task_artifacts ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
      }
      if (!artCols.some((c) => c.name === 'previous_id')) {
        db.exec(
          `ALTER TABLE task_artifacts ADD COLUMN previous_id INTEGER REFERENCES task_artifacts(id)`,
        );
      }

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

        CREATE TABLE IF NOT EXISTS task_collaborators (
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'collaborator',
          added_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (task_id, agent_id)
        );
        CREATE INDEX IF NOT EXISTS idx_collaborators_agent ON task_collaborators(agent_id);

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

      const pcCols = db.prepare(`PRAGMA table_info(pipeline_config)`).all() as { name: string }[];
      if (!pcCols.some((c) => c.name === 'approval_config')) {
        db.exec(`ALTER TABLE pipeline_config ADD COLUMN approval_config TEXT`);
      }
      if (!pcCols.some((c) => c.name === 'assignment_config')) {
        db.exec(`ALTER TABLE pipeline_config ADD COLUMN assignment_config TEXT`);
      }

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
    },
  },
  {
    version: 3,
    up: (db: Database.Database) => {
      const depCols = db.prepare(`PRAGMA table_info(task_dependencies)`).all() as {
        name: string;
      }[];
      if (!depCols.some((c) => c.name === 'relationship')) {
        db.exec(
          `ALTER TABLE task_dependencies ADD COLUMN relationship TEXT NOT NULL DEFAULT 'blocks'`,
        );
      }
    },
  },
  {
    version: 4,
    up: (db: Database.Database) => {
      const pcCols = db.prepare(`PRAGMA table_info(pipeline_config)`).all() as { name: string }[];
      if (!pcCols.some((c) => c.name === 'gate_config')) {
        db.exec(`ALTER TABLE pipeline_config ADD COLUMN gate_config TEXT`);
      }
    },
  },
  {
    version: 5,
    up: (db: Database.Database) => {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_dependencies(depends_on)`,
      );
    },
  },
];
