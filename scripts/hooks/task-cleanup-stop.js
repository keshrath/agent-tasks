#!/usr/bin/env node

// =============================================================================
// Task Cleanup Enforcer (Stop + SubagentStop hook)
//
// Sweeps tasks whose assigned agent is no longer online (dead-session cleanup)
// and auto-fails them. Never blocks — Claude Code Stop hooks can't reliably
// derive the stopping session's agent-comm name, so we can't nag "your" tasks
// without false-positives. Dead-session sweep is safe and idempotent and
// complements the SessionStart hook's own sweep.
// =============================================================================

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';

const DB_PATH = process.env.AGENT_TASKS_DB || join(homedir(), '.agent-tasks', 'agent-tasks.db');
const COMM_DB_PATH = join(homedir(), '.agent-comm', 'agent-comm.db');

function getOnlineAgentNames() {
  try {
    const db = new Database(COMM_DB_PATH, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`SELECT name FROM agents WHERE status = 'online'`).all();
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
    } catch {
      console.log(JSON.stringify({}));
    }
  });
}

function run() {
  if (!existsSync(DB_PATH)) {
    console.log(JSON.stringify({}));
    return;
  }

  const onlineAgents = getOnlineAgentNames();
  const db = new Database(DB_PATH, { readonly: false });

  const allOpenTasks = db
    .prepare(
      `SELECT id, title, status, stage, assigned_to FROM tasks
       WHERE status IN ('pending', 'in_progress') AND assigned_to IS NOT NULL`,
    )
    .all();

  const orphanedTasks = allOpenTasks.filter((t) => !onlineAgents.has(t.assigned_to));

  if (!orphanedTasks.length) {
    db.close();
    console.log(JSON.stringify({}));
    return;
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const failStmt = db.prepare(
    `UPDATE tasks SET status = 'failed', result = ?, updated_at = ? WHERE id = ?`,
  );

  const failAll = db.transaction(() => {
    for (const task of orphanedTasks) {
      failStmt.run(
        `Session "${task.assigned_to}" ended without completing this task (auto-cleanup)`,
        now,
        task.id,
      );
    }
  });
  failAll();
  db.close();

  const ids = orphanedTasks.map((t) => `#${t.id}`).join(', ');
  console.log(
    JSON.stringify({
      decision: 'approve',
      reason: `Auto-failed ${orphanedTasks.length} orphaned task(s) from dead sessions: ${ids}. Session ending.`,
    }),
  );
}

main();
