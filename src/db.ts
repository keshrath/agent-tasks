import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

let db: Database.Database | null = null;

export function log(level: string, msg: string): void {
  process.stderr.write(`[agent-tasks:${level}] ${new Date().toISOString()} ${msg}\n`);
}

export async function initDb(): Promise<Database.Database> {
  if (db) return db;

  const inMemory = !!process.env.AGENT_TASKS_TEST;

  if (inMemory) {
    db = new Database(':memory:');
  } else {
    const dir = join(homedir(), '.claude');
    mkdirSync(dir, { recursive: true });
    const dbPath = process.env.AGENT_TASKS_DB || join(dir, 'agent-tasks.db');
    db = new Database(dbPath);
  }

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  initSchema(db);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function transaction<T>(fn: () => T): T {
  const database = getDb();
  return database.transaction(fn)();
}

function initSchema(database: Database.Database): void {
  database.exec(`
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
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status)`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_stage ON tasks(stage, priority)`);

  database.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id INTEGER NOT NULL,
      depends_on INTEGER NOT NULL,
      PRIMARY KEY (task_id, depends_on)
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS task_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_task_artifacts_task ON task_artifacts(task_id, stage)`,
  );

  database.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_config (
      project TEXT PRIMARY KEY,
      stages TEXT NOT NULL DEFAULT '["backlog","spec","plan","implement","test","review","done","cancelled"]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function queryAll<T>(sql: string, params?: unknown[]): T[] {
  const database = getDb();
  const stmt = database.prepare(sql);
  return (params?.length ? stmt.all(...params) : stmt.all()) as T[];
}

export function queryOne<T>(sql: string, params?: unknown[]): T | null {
  const database = getDb();
  const stmt = database.prepare(sql);
  const row = params?.length ? stmt.get(...params) : stmt.get();
  return (row as T) ?? null;
}

export function run(sql: string, params?: unknown[]): Database.RunResult {
  const database = getDb();
  const stmt = database.prepare(sql);
  return params?.length ? stmt.run(...params) : stmt.run();
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch (e) {
      log('warn', `Error closing db: ${e}`);
    }
    db = null;
  }
}
