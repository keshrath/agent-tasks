#!/usr/bin/env node

// =============================================================================
// Stale Task Cleanup (SessionStart hook)
//
// On session start, finds tasks assigned to sessions that are no longer running
// (no matching hub-session.*.json with a live PID) and auto-fails them.
// Catches tasks orphaned by crashes/kills where Stop hook never fired.
// =============================================================================

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';

const DB_PATH = process.env.AGENT_TASKS_DB || join(homedir(), '.agent-tasks', 'agent-tasks.db');

function getActiveSessions() {
  const claudeDir = join(homedir(), '.claude');
  const active = new Set();
  for (const dir of [join(claudeDir, 'sessions'), claudeDir]) {
    try {
      const files = readdirSync(dir).filter(
        (f) => f.startsWith('hub-session.') && f.endsWith('.json'),
      );
      for (const f of files) {
        try {
          const info = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
          if (info.name) active.add(info.name);
        } catch {}
      }
    } catch {}
  }
  return active;
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    try {
      run();
    } catch (err) {
      process.stderr.write(`[task-cleanup-start] ${err.message}\n`);
      console.log(JSON.stringify({}));
    }
  });
}

function run() {
  if (!existsSync(DB_PATH)) {
    console.log(JSON.stringify({}));
    return;
  }

  const db = new Database(DB_PATH, { readonly: false });

  const assignees = db
    .prepare(
      `SELECT DISTINCT assigned_to FROM tasks
     WHERE assigned_to IS NOT NULL AND status IN ('pending', 'in_progress')`,
    )
    .pluck()
    .all();

  if (!assignees.length) {
    db.close();
    console.log(JSON.stringify({}));
    return;
  }

  const activeSessions = getActiveSessions();
  const staleAssignees = assignees.filter((a) => !activeSessions.has(a));

  if (!staleAssignees.length) {
    db.close();
    console.log(JSON.stringify({}));
    return;
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const failStmt = db.prepare(
    `UPDATE tasks SET status = 'failed',
       result = 'Session "' || ? || '" no longer running (stale task cleanup on session start)',
       updated_at = ?
     WHERE assigned_to = ? AND status IN ('pending', 'in_progress')`,
  );

  let cleaned = 0;
  const cleanAll = db.transaction(() => {
    for (const assignee of staleAssignees) {
      const result = failStmt.run(assignee, now, assignee);
      cleaned += result.changes;
    }
  });
  cleanAll();
  db.close();

  if (cleaned > 0) {
    process.stderr.write(
      `[task-cleanup-start] Auto-failed ${cleaned} task(s) from ${staleAssignees.length} dead session(s)\n`,
    );
  }

  console.log(JSON.stringify({}));
}

main();
