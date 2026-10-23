#!/usr/bin/env node

// =============================================================================
// Stale Task Cleanup (SessionStart hook)
//
// On session start, finds tasks assigned to sessions that are no longer running
// (no live agent in agent-comm DB) and auto-fails them.
// Catches tasks orphaned by crashes/kills where Stop hook never fired.
//
// Two guards keep the sweep from killing live work (mirrors
// task-cleanup-stop.js):
// 1. An agent counts as alive when its status is 'online' OR its
//    last_heartbeat is fresh — status can lag behind a heartbeat timeout.
// 2. A task is only reaped after an idle grace window: tasks updated recently
//    are actively being worked, even if the assignee name doesn't match a
//    registered agent (claim names and comm names can legitimately differ).
// =============================================================================

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';

const DB_PATH = process.env.AGENT_TASKS_DB || join(homedir(), '.agent-tasks', 'agent-tasks.db');
const COMM_DB_PATH = process.env.AGENT_COMM_DB || join(homedir(), '.agent-comm', 'agent-comm.db');
const GRACE_MINUTES = parseInt(process.env.AGENT_TASKS_DEAD_SESSION_GRACE_MINUTES ?? '60', 10);
const HEARTBEAT_FRESH_MINUTES = parseInt(
  process.env.AGENT_TASKS_HEARTBEAT_FRESH_MINUTES ?? '15',
  10,
);

// Timestamps in both DBs are stored as UTC 'YYYY-MM-DD HH:MM:SS' strings.
function utcCutoff(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60000).toISOString().replace('T', ' ').slice(0, 19);
}

function getLiveAgentNames() {
  try {
    const db = new Database(COMM_DB_PATH, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(`SELECT name FROM agents WHERE status = 'online' OR last_heartbeat >= ?`)
      .all(utcCutoff(HEARTBEAT_FRESH_MINUTES));
    db.close();
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
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

  const openTasks = db
    .prepare(
      `SELECT id, assigned_to, updated_at, created_at FROM tasks
       WHERE assigned_to IS NOT NULL AND status IN ('pending', 'in_progress')`,
    )
    .all();

  if (!openTasks.length) {
    db.close();
    console.log(JSON.stringify({}));
    return;
  }

  const liveAgents = getLiveAgentNames();
  const graceCutoff = utcCutoff(GRACE_MINUTES);
  const staleTasks = openTasks.filter(
    (t) => !liveAgents.has(t.assigned_to) && (t.updated_at || t.created_at || '') < graceCutoff,
  );

  if (!staleTasks.length) {
    db.close();
    console.log(JSON.stringify({}));
    return;
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const failStmt = db.prepare(
    `UPDATE tasks SET status = 'failed',
       result = 'Session "' || ? || '" no longer running (stale task cleanup on session start)',
       updated_at = ?
     WHERE id = ? AND status IN ('pending', 'in_progress')`,
  );

  let cleaned = 0;
  const cleanAll = db.transaction(() => {
    for (const task of staleTasks) {
      const result = failStmt.run(task.assigned_to, now, task.id);
      cleaned += result.changes;
    }
  });
  cleanAll();
  db.close();

  if (cleaned > 0) {
    process.stderr.write(`[task-cleanup-start] Auto-failed ${cleaned} stale task(s)\n`);
  }

  console.log(JSON.stringify({}));
}

main();
