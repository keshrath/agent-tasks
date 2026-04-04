#!/usr/bin/env node

// =============================================================================
// Task Cleanup Enforcer (Stop + SubagentStop hook)
//
// Ensures pipeline tasks don't get orphaned when a session ends.
//
// Attempt 1: Block stop, tell Claude to complete/fail its tasks.
// Attempt 2: Auto-fail all orphaned tasks directly in the DB, allow stop.
// =============================================================================

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';

const MAX_BLOCKS = 1;
const COUNTER_FILE = join(homedir(), '.claude', 'task-cleanup-counter.json');
const DB_PATH = process.env.AGENT_TASKS_DB || join(homedir(), '.agent-tasks', 'agent-tasks.db');

function getSessionName() {
  const agentCommDb = join(homedir(), '.agent-comm', 'agent-comm.db');
  try {
    const db = new Database(agentCommDb, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        `SELECT name FROM agents WHERE status = 'online' ORDER BY last_heartbeat DESC LIMIT 1`,
      )
      .get();
    db.close();
    if (row && row.name) return row.name;
  } catch {}
  return null;
}

function getBlockCount(sessionName) {
  try {
    if (existsSync(COUNTER_FILE)) {
      const counter = JSON.parse(readFileSync(COUNTER_FILE, 'utf-8'));
      if (counter.session === sessionName) return counter.count || 0;
    }
  } catch {}
  return 0;
}

function setBlockCount(sessionName, count) {
  try {
    writeFileSync(COUNTER_FILE, JSON.stringify({ session: sessionName, count }));
  } catch {}
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
  const sessionName = getSessionName();
  if (!sessionName || !existsSync(DB_PATH)) {
    console.log(JSON.stringify({}));
    return;
  }

  const db = new Database(DB_PATH, { readonly: false });
  const tasks = db
    .prepare(
      `SELECT id, title, status, stage FROM tasks
     WHERE assigned_to = ? AND status IN ('pending', 'in_progress')`,
    )
    .all(sessionName);

  if (!tasks.length) {
    db.close();
    setBlockCount(sessionName, 0);
    console.log(JSON.stringify({}));
    return;
  }

  const blockCount = getBlockCount(sessionName);
  const taskList = tasks.map((t) => `#${t.id} [${t.status}@${t.stage}] ${t.title}`).join('\n  ');

  if (blockCount < MAX_BLOCKS) {
    db.close();
    setBlockCount(sessionName, blockCount + 1);
    console.log(
      JSON.stringify({
        decision: 'block',
        reason: `You have ${tasks.length} incomplete task(s):\n  ${taskList}\n\nComplete (task_complete) or fail (task_fail) each task before stopping. If you stop again without resolving them, they will be auto-failed.`,
      }),
    );
    return;
  }

  // Auto-fail and allow stop
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const failStmt = db.prepare(
    `UPDATE tasks SET status = 'failed', result = ?, updated_at = ? WHERE id = ?`,
  );

  const failAll = db.transaction(() => {
    for (const task of tasks) {
      failStmt.run(
        `Session "${sessionName}" ended without completing this task (auto-cleanup)`,
        now,
        task.id,
      );
    }
  });
  failAll();
  db.close();

  const ids = tasks.map((t) => `#${t.id}`).join(', ');
  setBlockCount(sessionName, 0);
  console.log(
    JSON.stringify({
      decision: 'allow',
      reason: `Auto-failed ${tasks.length} orphaned task(s): ${ids}. Session ending.`,
    }),
  );
}

main();
