# agent-tasks

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-378%20passing-brightgreen)]()
[![MCP Tools](https://img.shields.io/badge/MCP%20tools-8-purple)]()
[![REST Endpoints](https://img.shields.io/badge/REST-18%20endpoints-orange)]()

**Pipeline-driven task management for AI coding agents.** An [MCP](https://modelcontextprotocol.io/) server with stage-gated pipelines, multi-agent collaboration, and a real-time kanban dashboard. Tasks flow through configurable stages — `backlog`, `spec`, `plan`, `implement`, `test`, `review`, `done` — with dependency tracking, approval workflows, artifact versioning, and threaded comments.

Built for AI coding agents (Claude Code, Codex CLI, Gemini CLI, Aider) but works equally well with any MCP client, REST consumer, or WebSocket listener.

---

| Light Theme                                              | Dark Theme                                             |
| -------------------------------------------------------- | ------------------------------------------------------ |
| ![Light mode dashboard](docs/assets/dashboard-light.png) | ![Dark mode dashboard](docs/assets/dashboard-dark.png) |

---

## Why agent-tasks?

When you run multiple AI agents on the same codebase, they need a shared task pipeline — not just a flat todo list. They need stages, dependencies, approvals, and visibility.

---

## Features

- **Pipeline stages** — configurable per project: `backlog` > `spec` > `plan` > `implement` > `test` > `review` > `done`
- **Task dependencies** — DAG with automatic cycle detection; blocks advancement until resolved
- **Approval workflows** — stage-gated approve/reject with auto-regress on rejection
- **Multi-agent collaboration** — roles (collaborator, reviewer, watcher), claiming, assignment
- **Subtask hierarchies** — parent/child task trees with progress tracking
- **Threaded comments** — async discussions between agents on any task
- **Artifact versioning** — per-stage document attachments with automatic versioning and diff viewer
- **Full-text search** — FTS5 search across task titles and descriptions
- **Real-time kanban dashboard** — drag-and-drop, side panel, inline creation, dark/light theme
- **3 transport layers** — MCP (stdio), REST API (HTTP), WebSocket (real-time events)
- **TodoWrite bridge** — intercepts Claude Code's built-in TodoWrite and syncs to the pipeline
- **Stage gates** — configurable per-project gates with per-stage rules: require named artifacts, minimum artifact counts, comments, or approvals before advancing
- **Decisions log** — structured decision artifacts (chose X over Y because Z) via `task_artifact(type: "decision")`
- **Learnings propagation** — `task_artifact(type: "learning")` captures insights (technique, pitfall, decision, pattern); auto-propagated to parent and sibling tasks on completion
- **Agent affinity** — `task_list(next: true)` prefers routing tasks to agents with related history (parent, dependency, project) as a tie-breaker
- **Heartbeat-based cleanup** — auto-fails tasks from dead agents using agent-comm heartbeat data
- **Task cleanup hooks** — auto-fails orphaned tasks on session stop and cleans up stale tasks on session start
- **Agent bridge** — notifies connected agents on task events

---

## Quick Start

### Install from npm

```bash
npm install -g agent-tasks
```

### Or clone from source

```bash
git clone https://github.com/keshrath/agent-tasks.git
cd agent-tasks
npm install
npm run build
```

### Option 1: MCP server (for AI agents)

Add to your MCP client config (Claude Code, Cline, etc.):

```json
{
  "mcpServers": {
    "agent-tasks": {
      "command": "npx",
      "args": ["agent-tasks"]
    }
  }
}
```

The dashboard auto-starts at http://localhost:3422 on the first MCP connection.

### Option 2: Standalone server (for REST/WebSocket clients)

```bash
node dist/server.js --port 3422
```

---

## Claude Code Integration

Once configured (see [Quick Start](#quick-start) above), Claude Code can use all 8 MCP tools directly — creating tasks, advancing stages, adding artifacts, commenting, and more. See the [Setup Guide](docs/SETUP.md) for detailed integration steps.

---

## MCP Tools (8)

| Category               | Tools                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Task CRUD** (4)      | `task_create`, `task_get` (include subtasks/artifacts/comments), `task_list` (search, next), `task_delete` |
| **Metadata** (1)       | `task_update` (title, description, priority, tags, project, assignment, dependencies)                      |
| **Lifecycle** (1)      | `task_stage` (claim, advance, regress, complete, fail, cancel)                                             |
| **Artifacts** (1)      | `task_artifact` (general, decision, learning, comment)                                                     |
| **Config & utils** (1) | `task_config` (pipeline, session, cleanup, rules)                                                          |

See [full API reference](docs/API.md) for detailed descriptions of every tool and endpoint.

## REST API (18 endpoints)

All endpoints return JSON. CORS enabled. See [full API reference](docs/API.md#rest-api-18-endpoints) for details.

```
GET  /health                          Health check with version + uptime
GET  /api/tasks                       List tasks (status, stage, project, assignee filters)
GET  /api/tasks/:id                   Get a single task
GET  /api/tasks/:id/subtasks          Subtasks of a parent
GET  /api/tasks/:id/artifacts         Artifacts (filter by stage)
GET  /api/tasks/:id/comments          Comments on a task
GET  /api/tasks/:id/dependencies      Dependencies for a task
GET  /api/dependencies                All dependencies across all tasks
GET  /api/pipeline                    Pipeline stage configuration
GET  /api/overview                    Full state dump
GET  /api/agents                      Online agents
GET  /api/search?q=                   Full-text search

POST /api/tasks                       Create a new task
PUT  /api/tasks/:id                   Update task fields
PUT  /api/tasks/:id/stage             Change stage (advance or regress)
POST /api/tasks/:id/comments          Add a comment
POST /api/cleanup                     Trigger manual cleanup
```

---

## Testing

```bash
npm test              # 337 tests across 12 suites
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
npm run check         # Full CI: typecheck + lint + format + test
```

---

## Environment variables

| Variable                   | Default                         | Description                                          |
| -------------------------- | ------------------------------- | ---------------------------------------------------- |
| `AGENT_TASKS_DB`           | `~/.agent-tasks/agent-tasks.db` | SQLite database file path                            |
| `AGENT_TASKS_PORT`         | `3422`                          | Dashboard HTTP/WebSocket port                        |
| `AGENT_TASKS_INSTRUCTIONS` | enabled                         | Set to `0` to disable response-embedded instructions |
| `AGENT_COMM_URL`           | `http://localhost:3421`         | Agent-comm REST URL for bridge notifications         |

---

## Dependencies

**Required**: Node.js >= 20.11, better-sqlite3 (bundled)

**Optional**: [agent-comm](https://github.com/keshrath/agent-comm) — Heartbeat-based task cleanup requires agent-comm running at `AGENT_COMM_URL` (default: `http://localhost:3421`). Without agent-comm, stale agent detection is skipped gracefully. Flow: agent-comm tracks heartbeats → agent-tasks checks heartbeats → auto-fails tasks from dead agents.

---

## Documentation

- [API Reference](docs/API.md) — all 8 MCP tools, 18 REST endpoints, WebSocket protocol
- [Architecture](docs/ARCHITECTURE.md) — source structure, design principles, database schema
- [Dashboard](docs/DASHBOARD.md) — kanban board features, keyboard shortcuts, screenshots
- [Setup Guide](docs/SETUP.md) — installation, client setup (Claude Code, OpenCode, Cursor, Windsurf), hooks
- [Changelog](CHANGELOG.md)

---

## License

MIT — see [LICENSE](LICENSE)
