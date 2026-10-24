# agent-tasks

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-472%20passing-brightgreen)]()
[![MCP Tools](https://img.shields.io/badge/MCP%20tools-8-purple)]()
[![REST Endpoints](https://img.shields.io/badge/REST-8%20endpoints-orange)]()

**Pipeline-driven task management for AI coding agents.** An [MCP](https://modelcontextprotocol.io/) server with stage-gated pipelines, multi-agent collaboration, and a native Claude Code `/pipeline` pane. Tasks flow through configurable stages — `backlog`, `spec`, `plan`, `implement`, `test`, `review`, `done` — with dependency tracking, stage gates, artifact versioning, and threaded comments.

Built for AI coding agents (Claude Code, Codex CLI, Gemini CLI, Aider) but works equally well with any MCP client or REST consumer.

![/pipeline opens the board beside a Claude Code conversation; Tab and Enter open a task](docs/images/manual/hero.gif)

The [user manual](docs/USER-MANUAL.md#4-the-pipeline-pane) shows every view and action of the pane, with screenshots and short clips from the real CLI.

2.0 replaced the web dashboard with the `/pipeline` pane inside Claude Code; there is no browser UI, WebSocket or agent-desk plugin any more.

### From 1.x

- The dashboard on http://localhost:3422 is gone: open the board with `/pipeline` in Claude Code (install the plugin, below). The agent-desk Tasks tab is gone with it.
- REST: `GET /api/overview` and `PUT /api/tasks/:id/stage` are gone (use `GET /api/board` and `POST /api/tasks/:id/stage` with `{"action": "advance"}`), and so are the routes nothing called; see [the REST API](#rest-api-8-endpoints).
- A 1.x process still holding port 3422 is named by the pane (`An older agent-tasks (1.10.13) holds the port`) and in the status line (`old server 1.10.13 on the port`): end the Claude Code sessions still running it (or kill the old `agent-tasks` process) so a 2.x process takes the port, then Refresh.

---

## Why agent-tasks?

When you run multiple AI agents on the same codebase, they need a shared task pipeline — not just a flat todo list. They need stages, dependencies, stage gates, and visibility.

---

## Features

- **Pipeline stages** — configurable per project: `backlog` > `spec` > `plan` > `implement` > `test` > `review` > `done`
- **Task dependencies** — DAG with automatic cycle detection; blocks advancement until resolved
- **Multi-agent claiming** — claim, assign, send back to an earlier stage with a reason
- **Subtask hierarchies** — parent/child task trees with progress tracking
- **Threaded comments** — async discussions between agents on any task
- **Artifact versioning** — per-stage document attachments with automatic versioning
- **Full-text search** — FTS5 search across task titles and descriptions
- **Claude Code `/pipeline` pane** — the board beside the conversation, keyboard-first: tasks by stage, task detail with artifacts and comments, advance, send back, complete, fail, cancel, comment and delete, a status line entry
- **2 transport layers** — MCP (stdio) and a loopback REST API (HTTP) that the pane reads
- **TodoWrite bridge** — intercepts Claude Code's built-in TodoWrite and syncs to the pipeline
- **Stage gates** — configurable per-project gates with per-stage rules: require named artifacts, minimum artifact counts or a comment before advancing (the schema also has `require_approval`, but no MCP tool or REST route records an approval, so a stage with it set cannot be left; keep it off)
- **Decisions log** — structured decision artifacts (chose X over Y because Z) via `task_artifact(type: "decision")`
- **Learnings propagation** — `task_artifact(type: "learning")` captures insights (technique, pitfall, decision, pattern); auto-propagated to parent and sibling tasks on completion
- **Agent affinity** — `task_list(next: true)` prefers routing tasks to agents with related history (parent, dependency, project) as a tie-breaker
- **Heartbeat-based cleanup** — auto-fails tasks from dead agents using agent-comm heartbeat data
- **Task cleanup hooks** — auto-fails orphaned tasks on session stop and cleans up stale tasks on session start
- **Agent bridge** — notifies connected agents on task events (claim, advance, comment)
- **Knowledge bridge** — auto-pushes learning and decision artifacts to agent-knowledge on task completion, with embedding indexing and auto-linking

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

The first MCP process to start also serves the REST API on http://localhost:3422; the others retry every 5 s and take over when it exits.

### Option 2: Claude Code plugin (MCP server + `/pipeline` pane)

```bash
claude plugin marketplace add keshrath/agent-tasks
claude plugin install agent-tasks@agent-tasks
```

The plugin runs the MCP server and adds a Claude Code mod (function hooks, Claude Code 2.1.289+): `/pipeline` opens the board beside the conversation. The [tutorial](docs/TUTORIAL.md) walks through it. Remove any hand-written `agent-tasks` entry from `~/.claude.json` so tools do not appear twice.

### Option 3: Standalone REST server

```bash
node dist/server.js --port 3422
```

---

## Claude Code Integration

Once configured (see [Quick Start](#quick-start) above), Claude Code can use all 8 MCP tools directly — creating tasks, advancing stages, adding artifacts, commenting, and more. With the plugin installed, `/pipeline` opens the board in a pane beside the conversation (Claude Code 2.1.289+). See the [Setup Guide](docs/SETUP.md) for detailed integration steps.

---

## MCP Tools (8)

| Category               | Tools                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Task CRUD** (4)      | `task_create`, `task_get` (include subtasks/artifacts/comments/transitive_deps), `task_list` (search, next), `task_delete` |
| **Metadata** (1)       | `task_update` (title, description, priority, tags, project, assignment, dependencies)                                      |
| **Lifecycle** (1)      | `task_stage` (claim, assign, advance, regress, complete, fail, cancel)                                                     |
| **Artifacts** (1)      | `task_artifact` (general, decision, learning, comment)                                                                     |
| **Config & utils** (1) | `task_config` (pipeline, session, cleanup, rules)                                                                          |

See [full API reference](docs/API.md) for detailed descriptions of every tool and endpoint.

## REST API (8 endpoints)

All endpoints return JSON. Loopback only: a foreign `Host` gets 403, so does any request carrying an `Origin` header (no browser calls this API), and request bodies must be `application/json`. Everything else goes through the MCP tools. See [full API reference](docs/API.md#rest-api-8-endpoints) for details.

```
GET    /health                        Health check with version + uptime
GET    /api/tasks/:id                 One task, as task_get (?include=subtasks,comments,transitive_deps)
GET    /api/pipeline                  Pipeline stage configuration
GET    /api/board                     Open and recently closed tasks (what the pane polls)

POST   /api/tasks                     Create a task
POST   /api/tasks/:id/stage           Lifecycle action (claim, assign, advance, regress, complete, fail, cancel)
POST   /api/tasks/:id/comments        Add a comment
DELETE /api/tasks/:id                 Delete a task
```

---

## Testing

```bash
npm test              # vitest: 472 tests across 25 files
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
npm run check         # Full CI: typecheck + lint + format + test
npm run plugin:check  # the /pipeline pane: claude plugin validate + its tests (needs the claude CLI)
npm run e2e:claude    # the pane in the real Claude Code CLI (see CONTRIBUTING.md)
```

---

## Environment variables

| Variable                                 | Default                         | Description                                                                    |
| ---------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| `AGENT_TASKS_DB`                         | `~/.agent-tasks/agent-tasks.db` | SQLite database file path                                                      |
| `AGENT_TASKS_PORT`                       | `3422`                          | REST API port (the `/pipeline` pane reads it)                                  |
| `AGENT_TASKS_HOST`                       | `127.0.0.1`                     | REST bind address (`0.0.0.0` exposes it to the network)                        |
| `AGENT_TASKS_USER`                       | the OS user                     | Who the `/pipeline` pane acts as (`created_by`, comment author, `by`)          |
| `AGENT_TASKS_INSTRUCTIONS`               | enabled                         | Set to `0` to disable response-embedded instructions                           |
| `AGENT_TASKS_RETENTION_DAYS`             | `30`                            | Days the cleanup keeps resolved approval records                               |
| `AGENT_TASKS_COMPLETED_RETENTION_DAYS`   | `7`                             | Days a completed task is kept (and listed under the pane's Done) before purge  |
| `AGENT_TASKS_FAILED_RETENTION_DAYS`      | `7`                             | Days a failed task is kept before purge                                        |
| `AGENT_TASKS_CANCELLED_RETENTION_DAYS`   | `1`                             | Days a cancelled task is kept before purge                                     |
| `AGENT_TASKS_ORPHAN_TIMEOUT_MINUTES`     | `360`                           | Minutes before an in-progress task with no assignee is cancelled               |
| `AGENT_TASKS_COMM_TIMEOUT_MS`            | `5000`                          | Timeout of the cleanup's agent-comm requests                                   |
| `AGENT_TASKS_DEAD_SESSION_GRACE_MINUTES` | `60`                            | `task-cleanup-start.js`: idle minutes before a dead session's task is failed   |
| `AGENT_TASKS_HEARTBEAT_FRESH_MINUTES`    | `15`                            | `task-cleanup-start.js`: an agent with a heartbeat this recent counts as alive |
| `AGENT_COMM_URL`                         | `http://localhost:3421`         | Agent-comm REST URL for bridge notifications                                   |
| `AGENT_KNOWLEDGE_URL`                    | `http://localhost:3423`         | Agent-knowledge REST URL for knowledge bridge                                  |

---

## Dependencies

**Required**: Node.js >= 20.11, better-sqlite3 (bundled)

**Optional (soft dependencies — fail-open, HTTP-only, no npm dep):**

- [agent-comm](https://github.com/keshrath/agent-comm) — Heartbeat-based task cleanup and event notifications. agent-comm tracks heartbeats → agent-tasks checks heartbeats → auto-fails tasks from dead agents. Also sends direct messages on claim/advance and posts to a channel on comments. Without agent-comm, stale agent detection and notifications are skipped gracefully.

- [agent-knowledge](https://github.com/keshrath/agent-knowledge) — Knowledge persistence for task learnings and decisions. On task completion, the KnowledgeBridge pushes `learning` and `decision` artifacts to agent-knowledge via `POST /api/knowledge`. Entries are auto-indexed with embeddings, auto-linked to similar entries, and git-synced. Without agent-knowledge, artifacts stay in agent-tasks only.

---

## Documentation

- [Tutorial](docs/TUTORIAL.md) — the `/pipeline` pane step by step, recorded from the real CLI
- [User Manual](docs/USER-MANUAL.md) — the `/pipeline` pane view by view (screenshots and GIFs), every tool, the pipeline, gates, cleanup
- [API Reference](docs/API.md) — all 8 MCP tools and the REST endpoints
- [Hooks](docs/hooks.md) — the Claude Code command hooks `scripts/setup.js` installs
- [Architecture](docs/ARCHITECTURE.md) — source structure, design principles, database schema
- [Setup Guide](docs/SETUP.md) — installation, client setup (Claude Code, OpenCode, Cursor, Windsurf), hooks
- [Contributing](CONTRIBUTING.md) — development, tests, the e2e run in the real CLI
- [Changelog](CHANGELOG.md)

---

## License

MIT — see [LICENSE](LICENSE)
