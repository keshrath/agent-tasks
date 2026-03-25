# Setup Guide

Detailed instructions for installing, configuring, and integrating agent-tasks.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Claude Code Integration](#claude-code-integration)
- [Hooks Setup (TodoWrite Bridge)](#hooks-setup-todowrite-bridge)
- [Running as Standalone Server](#running-as-standalone-server)
- [Configuration Options](#configuration-options)
- [Database](#database)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js** >= 20.11 (for native ES module support and `node:` built-in imports)
- **npm** >= 10

Verify your versions:

```bash
node --version   # Should be v20.11.0 or later
npm --version    # Should be v10 or later
```

---

## Installation

### From source

```bash
git clone https://github.com/keshrath/agent-tasks.git
cd agent-tasks
npm install
npm run build
```

This compiles TypeScript to `dist/` and copies UI files to `dist/ui/`.

### Verify installation

```bash
node dist/server.js
```

Open **http://localhost:3422** in your browser. You should see the kanban dashboard with empty columns for each pipeline stage.

---

## Claude Code Integration

agent-tasks works as an MCP server that Claude Code communicates with over stdio.

### Step 1: Add the MCP server

Edit `~/.claude/settings.json` (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "agent-tasks": {
      "command": "node",
      "args": ["/absolute/path/to/agent-tasks/dist/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/agent-tasks` with the actual path where you cloned the repo.

### Step 2: Verify

Start a new Claude Code session. You should see agent-tasks listed as an available MCP server. Try:

> Create a task called "Test task" with priority 5

Claude should call `task_create` and confirm the task was created.

### Step 3: Open the dashboard

The dashboard auto-starts when the MCP server launches. Open **http://localhost:3422** to see your tasks on the kanban board.

---

## Hooks Setup (TodoWrite Bridge)

The TodoWrite bridge intercepts Claude Code's built-in `TodoWrite` tool and syncs todos to agent-tasks. This means Claude's internal todo tracking automatically populates your pipeline.

### Step 1: Create the hook script

Create a file at a stable location (e.g., `~/.claude/hooks/todowrite-bridge.js`):

```javascript
#!/usr/bin/env node

// TodoWrite Bridge — syncs Claude Code todos to agent-tasks

import http from 'http';

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
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  try {
    const event = JSON.parse(input);
    if (event.tool_name === 'TodoWrite' && event.tool_input) {
      const todos = event.tool_input.todos || [];
      for (const todo of todos) {
        if (todo.status === 'in_progress' || todo.status === 'pending') {
          await postTask({
            title: todo.content,
            priority: todo.priority === 'high' ? 10 : todo.priority === 'medium' ? 5 : 1,
            project: 'claude-todos',
          });
        }
      }
    }
  } catch {
    /* ignore parse errors */
  }

  // Return empty object to let the original tool proceed
  console.log(JSON.stringify({}));
}

main();
```

### Step 2: Configure the hook

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "TodoWrite",
        "command": "node /absolute/path/to/hooks/todowrite-bridge.js"
      }
    ]
  }
}
```

### Step 3: Verify

Start a Claude Code session and ask it to create some todos. They should appear on the agent-tasks dashboard in the `backlog` column.

---

## Running as Standalone Server

You can run agent-tasks as a standalone HTTP + WebSocket server without MCP:

```bash
# Default port (3422)
npm run start:server

# Custom port
npm run start:server -- --port 8080

# Or directly
node dist/server.js --port 8080
```

This is useful for:

- Viewing the dashboard while MCP servers run in separate terminals
- Integrating via REST API from scripts or other tools
- Running alongside agent-comm for multi-agent setups

---

## Configuration Options

### Environment variables

| Variable                   | Default                         | Description                                                       |
| -------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| `AGENT_TASKS_DB`           | `~/.agent-tasks/agent-tasks.db` | Path to the SQLite database file                                  |
| `AGENT_TASKS_PORT`         | `3422`                          | HTTP/WebSocket port for the dashboard                             |
| `AGENT_TASKS_INSTRUCTIONS` | enabled                         | Set to `0` to disable embedded instructions in MCP tool responses |
| `AGENT_COMM_URL`           | `http://localhost:3421`         | Agent-comm REST API URL (for bridge notifications)                |

### Custom pipeline stages

The default pipeline is: `backlog` > `spec` > `plan` > `implement` > `test` > `review` > `done`

You can customize stages per project using the `task_pipeline_config` MCP tool:

```
Use task_pipeline_config to set stages for project "my-project" to: ["todo", "doing", "testing", "done"]
```

Or via REST:

```bash
# Get current pipeline config
curl http://localhost:3422/api/pipeline

# Get pipeline for a specific project
curl http://localhost:3422/api/pipeline?project=my-project
```

---

## Database

### Location

By default, the database is stored at `~/.agent-tasks/agent-tasks.db`. Override with `AGENT_TASKS_DB`.

### Backup

The database is a single SQLite file. To back up:

```bash
cp ~/.agent-tasks/agent-tasks.db ~/.agent-tasks/agent-tasks.db.bak
```

### Reset

To start fresh, delete the database file:

```bash
rm ~/.agent-tasks/agent-tasks.db
```

A new database will be created automatically on the next start.

### Schema

The database uses schema versioning (currently V3) with automatic migrations. Migrations are idempotent — the server handles upgrades automatically.

---

## Troubleshooting

### Dashboard shows "Connecting..."

- Verify the server is running: `curl http://localhost:3422/health`
- Check the port isn't in use: `lsof -i :3422` (macOS/Linux) or `netstat -ano | findstr 3422` (Windows)
- Try a different port: `AGENT_TASKS_PORT=8080 npm run start:server`

### MCP tools not appearing in Claude Code

- Verify the path in `settings.json` is absolute and points to `dist/index.js`
- Ensure you ran `npm run build` after cloning
- Restart Claude Code after changing `settings.json`

### Tasks not syncing between terminals

- The WebSocket server polls SQLite every 2 seconds to detect cross-process changes
- Ensure all MCP instances use the same database file (`AGENT_TASKS_DB`)

### TodoWrite bridge not working

- Verify the hook script path is absolute in `settings.json`
- Check that the agent-tasks server is running (the bridge POSTs to the REST API)
- Check stderr for errors: the bridge logs to stderr with `[todowrite-bridge]` prefix
