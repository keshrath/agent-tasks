#!/usr/bin/env node

// =============================================================================
// agent-tasks TodoWrite bridge (PreToolUse)
//
// Intercepts Claude Code's built-in TodoWrite tool and mirrors each pending
// todo into the pipeline via the REST API. Runs before the original tool so
// the todos show up on the dashboard in real time. Fail-open — a dashboard
// that isn't running must never block the tool call.
// =============================================================================

import http from 'node:http';

process.on('uncaughtException', (err) => {
  process.stderr.write(`[todowrite-bridge] fatal: ${err.message}\n`);
  console.log(JSON.stringify({}));
  process.exit(0);
});

const AGENT_TASKS_URL = process.env.AGENT_TASKS_URL || 'http://localhost:3422';

function postTask(task) {
  return new Promise((resolve) => {
    const data = JSON.stringify(task);
    const url = new URL('/api/tasks', AGENT_TASKS_URL);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 3000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      },
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(data);
    req.end();
  });
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

  const toolName = hookData?.tool_name || '';
  const toolInput = hookData?.tool_input || {};

  if (toolName !== 'TodoWrite' && toolName !== 'TaskCreate') {
    console.log(JSON.stringify({}));
    return;
  }

  try {
    const todos = toolInput.todos || [];
    for (const todo of todos) {
      if (!todo.content) continue;
      if ((todo.status || 'pending') === 'completed') continue;

      await postTask({
        title: todo.content.slice(0, 500),
        description: todo.id ? `Synced from TodoWrite (id: ${todo.id})` : 'Synced from TodoWrite',
        priority: todo.priority === 'high' ? 5 : todo.priority === 'low' ? 1 : 3,
        created_by: 'todowrite-bridge',
        project: 'claude-todos',
        tags: ['synced', 'todowrite'],
      });
    }
  } catch {
    // Non-critical — don't block the tool
  }

  console.log(JSON.stringify({}));
}

main().catch((err) => {
  process.stderr.write(`[todowrite-bridge] ${err.message}\n`);
  console.log(JSON.stringify({}));
});
