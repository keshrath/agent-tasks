// =============================================================================
// Storage — fresh databases, and a 1.x database (agent-common's migration
// runner, schema V5) opening unchanged under the own wrapper
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDb, schemaVersion, type Db } from '../src/storage/database.js';
import { createContext, type AppContext } from '../src/context.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'agent-tasks-1.10.13.db');
const LATEST = 7;

const dirs: string[] = [];
const open: Array<Db | AppContext> = [];

afterEach(() => {
  for (const o of open.splice(0)) o.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-tasks-db-'));
  dirs.push(dir);
  return dir;
}

const tables = (db: Db) =>
  db
    .queryAll<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .map((r) => r.name);

describe('createDb', () => {
  it('builds a fresh database at the latest schema version', () => {
    const db = createDb({ path: join(scratch(), 'fresh.db') });
    open.push(db);
    expect(schemaVersion(db.raw)).toBe(LATEST);
    expect(tables(db)).toEqual(
      expect.arrayContaining([
        '_meta',
        'tasks',
        'task_dependencies',
        'task_artifacts',
        'pipeline_config',
        'task_comments',
        'task_collaborators',
        'task_approvals',
        'tasks_fts',
      ]),
    );
  });

  it('turns on WAL, foreign keys and a busy timeout', () => {
    const db = createDb({ path: join(scratch(), 'pragmas.db') });
    open.push(db);
    expect(db.raw.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.raw.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('runs, queries one and many, and rolls a failing transaction back', () => {
    const db = createDb({ path: ':memory:' });
    open.push(db);
    db.run(`INSERT INTO tasks (title, created_by) VALUES (?, ?)`, ['One', 'test']);
    expect(db.queryOne<{ title: string }>(`SELECT title FROM tasks`)?.title).toBe('One');
    expect(db.queryOne(`SELECT * FROM tasks WHERE id = ?`, [99])).toBeNull();
    expect(() =>
      db.transaction(() => {
        db.run(`INSERT INTO tasks (title, created_by) VALUES ('Two', 'test')`);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.queryAll(`SELECT * FROM tasks`)).toHaveLength(1);
  });

  it('is idempotent: reopening a database applies nothing twice', () => {
    const path = join(scratch(), 'twice.db');
    const first = createDb({ path });
    first.run(`INSERT INTO tasks (title, created_by) VALUES ('Kept', 'test')`);
    first.close();
    const second = createDb({ path });
    open.push(second);
    expect(schemaVersion(second.raw)).toBe(LATEST);
    expect(second.queryAll(`SELECT * FROM tasks`)).toHaveLength(1);
  });

  it('migrates a database left at an older version up to the latest', () => {
    const path = join(scratch(), 'old.db');
    const db = createDb({ path });
    db.run(`UPDATE _meta SET value = '3' WHERE key = 'schema_version'`);
    db.run(`DROP INDEX idx_task_deps_depends_on`);
    db.close();
    const again = createDb({ path });
    open.push(again);
    expect(schemaVersion(again.raw)).toBe(LATEST);
    expect(
      again.queryOne(`SELECT name FROM sqlite_master WHERE name = 'idx_task_deps_depends_on'`),
    ).not.toBeNull();
  });

  it('closes twice without throwing', () => {
    const db = createDb({ path: ':memory:' });
    db.close();
    expect(() => db.close()).not.toThrow();
  });
});

describe('a database written by agent-tasks 1.10.13', () => {
  function legacy(): string {
    const path = join(scratch(), 'legacy.db');
    copyFileSync(FIXTURE, path);
    return path;
  }

  it('opens at its version with every row intact', () => {
    const db = createDb({ path: legacy() });
    open.push(db);
    expect(schemaVersion(db.raw)).toBe(LATEST);
    expect(
      db.queryAll<{ title: string; status: string; stage: string }>(
        `SELECT title, status, stage FROM tasks ORDER BY id`,
      ),
    ).toEqual([
      { title: 'Legacy parent', status: 'in_progress', stage: 'spec' },
      { title: 'Legacy child', status: 'pending', stage: 'backlog' },
    ]);
  });

  it('works through the whole app: reads, writes, its project pipeline and search', () => {
    const ctx = createContext({ path: legacy() });
    open.push(ctx);
    const parent = ctx.tasks.getById(1)!;
    expect(JSON.parse(String(parent.tags))).toEqual(['old']);
    expect(ctx.tasks.getArtifacts(1).map((a) => a.content)).toEqual(['The legacy spec']);
    expect(ctx.comments.list(1).map((c) => c.content)).toEqual(['A legacy comment']);
    expect(ctx.tasks.getPipelineStages('legacy')).toEqual(['todo', 'doing', 'done']);
    expect(ctx.tasks.search('legacy').length).toBeGreaterThan(0);
    expect(() => ctx.tasks.advance(2)).toThrow();

    const added = ctx.tasks.create({ title: 'Written by 2.x', parent_id: 1 }, 'agent-2');
    expect(added.project).toBe('legacy');
    expect(ctx.tasks.getById(added.id)?.title).toBe('Written by 2.x');
  });
});

describe('transactions', () => {
  // Deferred, a transaction that reads and then writes under WAL fails at once when another
  // process wrote in between (SQLITE_BUSY_SNAPSHOT, no busy timeout). IMMEDIATE takes the
  // write lock first: another writer waits (here: is refused at once) instead.
  it('take the write lock when they start', () => {
    const path = join(scratch(), 'tx.db');
    const a = createDb({ path });
    const b = createDb({ path });
    open.push(a, b);
    b.raw.pragma('busy_timeout = 0');
    let other: unknown = null;
    a.transaction(() => {
      a.queryOne(`SELECT 1`);
      try {
        b.run(`INSERT INTO _meta (key, value) VALUES ('probe', '1')`);
      } catch (err) {
        other = err;
      }
    });
    expect(String(other)).toMatch(/SQLITE_BUSY|database is locked/);
  });
});
