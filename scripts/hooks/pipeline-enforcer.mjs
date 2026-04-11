#!/usr/bin/env node

// =============================================================================
// agent-tasks pipeline enforcer (UserPromptSubmit)
//
// If the prompt looks like real work, checks that the session has a
// registered agent-comm identity AND an active pipeline task. Injects a
// reminder into the prompt when the rule is violated. Fail-open on any
// crash — never block the user.
// =============================================================================

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';

process.on('uncaughtException', (err) => {
  process.stderr.write(`[pipeline-enforcer] fatal: ${err.message}\n`);
  console.log(JSON.stringify({}));
  process.exit(0);
});

const AGENT_COMM_DB = process.env.AGENT_COMM_DB || join(homedir(), '.agent-comm', 'agent-comm.db');
const AGENT_TASKS_DB =
  process.env.AGENT_TASKS_DB || join(homedir(), '.agent-tasks', 'agent-tasks.db');

const QUESTION_PATTERNS = [
  /^\s*(what|how|why|when|where|who|which|can you|could you|is it|are there|does|do you|explain|tell me|show me|recommend|suggest)\b/i,
  /\?\s*$/,
];

const GREETING_PATTERNS = [
  /^\s*(hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|bye|goodbye|ok|yes|no|sure|yep|nope|continue|go)\b/i,
];

const META_PATTERNS = [
  /^\s*\//,
  /^\s*(commit|push|pull|status|log|diff|remember|forget|save|store)\b/i,
  /^\s*do\s+(\d|step|item|task|#\d|all|both|the\s+(first|second|third|next|last))/i,
  /^\s*(start|begin|continue|proceed|finish|complete)\s+(with|on|the)/i,
];

const SYSTEM_INJECTED_PREFIXES = [
  /^\s*<system-reminder>/i,
  /^\s*<task-notification>/i,
  /^\s*<local-command-caveat>/i,
  /^\s*<command-name>/i,
  /^\s*<command-message>/i,
];

function isWorkPrompt(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 15) return false;

  for (const p of SYSTEM_INJECTED_PREFIXES) if (p.test(trimmed)) return false;
  for (const p of GREETING_PATTERNS) if (p.test(trimmed)) return false;
  for (const p of META_PATTERNS) if (p.test(trimmed)) return false;

  let isQuestion = false;
  for (const p of QUESTION_PATTERNS) {
    if (p.test(trimmed)) {
      isQuestion = true;
      break;
    }
  }
  if (isQuestion && trimmed.length < 200) return false;

  return true;
}

function getSessionName() {
  if (!existsSync(AGENT_COMM_DB)) return null;
  try {
    const db = new Database(AGENT_COMM_DB, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        `SELECT name FROM agents WHERE status = 'online' ORDER BY last_heartbeat DESC LIMIT 1`,
      )
      .get();
    db.close();
    return row?.name ?? null;
  } catch {
    return null;
  }
}

function hasActiveTask(sessionName) {
  if (!existsSync(AGENT_TASKS_DB)) return false;
  try {
    const db = new Database(AGENT_TASKS_DB, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM tasks WHERE assigned_to = ? AND status IN ('pending', 'in_progress')`,
      )
      .get(sessionName);
    db.close();
    return (row?.cnt ?? 0) > 0;
  } catch {
    return false;
  }
}

function enforce(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `PIPELINE REQUIRED: ${reason}\n\nBefore doing this work, you MUST:\n1. Ensure you are registered with comm_register\n2. Create a task with task_create OR claim one with task_claim\n\nDo NOT start writing code or making changes until you have a pipeline task assigned to your session.`,
      },
    }),
  );
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({}));
    return;
  }

  const userMessage = hookData?.user_message || hookData?.prompt || '';
  if (!isWorkPrompt(userMessage)) {
    console.log(JSON.stringify({}));
    return;
  }

  const sessionName = getSessionName();
  if (!sessionName) {
    enforce('No registered agent found. You must call comm_register first.');
    return;
  }

  if (!hasActiveTask(sessionName)) {
    enforce(`Session "${sessionName}" has no active pipeline task.`);
    return;
  }

  console.log(JSON.stringify({}));
}

main().catch((err) => {
  process.stderr.write(`[pipeline-enforcer] ${err.message}\n`);
  console.log(JSON.stringify({}));
});
