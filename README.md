# agent-tasks

Pipeline-driven task management for AI coding agents. An [MCP](https://modelcontextprotocol.io/) server with stage-gated pipelines, multi-agent collaboration, and a real-time kanban dashboard.

Part of the **agent-\*** family: [`agent-comm`](https://github.com/keshrath/agent-comm) (messaging) + `agent-tasks` (pipeline).

## Features

- **Pipeline stages** — tasks flow through configurable stages: `backlog → spec → plan → implement → test → review → done`
- **Subtasks** — parent/child task hierarchies with progress tracking
- **Dependencies** — DAG with cycle detection; blocks advancement until resolved
- **Artifacts** — per-stage documents with automatic versioning (spec v1 → v2 → v3)
- **Comments** — threaded async discussion between agents on any task
- **Collaborators** — multiple agents per task with roles: collaborator, reviewer, watcher
- **Approvals** — stage-gated approval workflow (request → approve/reject)
- **Full-text search** — FTS5 search across titles and descriptions
- **Maker-checker** — review cycles with automatic regress on rejection
- **Auto-assignment** — configure agents to auto-assign at specific stages
- **Drag-and-drop kanban** — real-time dashboard at `:3422` with WebSocket live updates
- **TodoWrite bridge** — intercepts built-in TodoWrite calls and syncs to the pipeline
- **IDE rules** — generate `.mdc` (Cursor) or `CLAUDE.md` snippets for agent adoption
- **Agent-comm bridge** — notifies agents via agent-comm on task events

## Quick Start

```bash
npm install
npm run build
```

### As MCP Server (stdio)

```json
{
  "mcpServers": {
    "agent-tasks": {
      "command": "node",
      "args": ["/path/to/agent-tasks/dist/index.js"]
    }
  }
}
```

### Standalone Dashboard

```bash
npm run start:server        # http://localhost:3422
npm run start:server -- --port 8080
```

## MCP Tools (33)

| Tool                       | Description                                                                   |
| -------------------------- | ----------------------------------------------------------------------------- |
| `task_create`              | Create task (title, description, priority, project, tags, parent_id)          |
| `task_list`                | List with filters (status, stage, project, assignee, collaborator, root_only) |
| `task_claim`               | Claim pending task — assigns and advances from backlog                        |
| `task_advance`             | Advance to next stage (validates dependencies)                                |
| `task_regress`             | Regress to earlier stage with reason artifact                                 |
| `task_complete`            | Mark completed with result                                                    |
| `task_fail`                | Mark failed with error                                                        |
| `task_cancel`              | Cancel with reason                                                            |
| `task_update`              | Update metadata (title, description, priority, tags, assignee)                |
| `task_delete`              | Delete with cascading cleanup                                                 |
| `task_next`                | Get highest-priority unassigned unblocked task                                |
| `task_search`              | Full-text search across titles and descriptions                               |
| `task_get_subtasks`        | Get child tasks of a parent                                                   |
| `task_add_dependency`      | Add dependency (cycle detection)                                              |
| `task_remove_dependency`   | Remove dependency                                                             |
| `task_add_artifact`        | Attach document with auto-versioning                                          |
| `task_get_artifacts`       | Retrieve artifacts (filter by stage)                                          |
| `task_comment`             | Add threaded comment                                                          |
| `task_get_comments`        | List comments on a task                                                       |
| `task_add_collaborator`    | Add agent with role (collaborator/reviewer/watcher)                           |
| `task_remove_collaborator` | Remove collaborator                                                           |
| `task_request_approval`    | Request stage approval                                                        |
| `task_approve`             | Approve pending approval                                                      |
| `task_reject`              | Reject with required comment                                                  |
| `task_pending_approvals`   | List pending approvals                                                        |
| `task_review_cycle`        | Convenience approve/reject with auto stage change                             |
| `task_pipeline_config`     | Get or set pipeline stages per project                                        |
| `task_set_session`         | Set session identity                                                          |
| `task_generate_rules`      | Generate IDE rule files (.mdc or CLAUDE.md)                                   |

## REST API (15 endpoints)

| Method | Path                          | Description                             |
| ------ | ----------------------------- | --------------------------------------- |
| GET    | `/health`                     | Health check + version                  |
| GET    | `/api/tasks`                  | List tasks (query params for filters)   |
| POST   | `/api/tasks`                  | Create task                             |
| GET    | `/api/tasks/:id`              | Get task detail                         |
| PUT    | `/api/tasks/:id/stage`        | Change stage (advance or regress)       |
| GET    | `/api/tasks/:id/subtasks`     | Get subtasks                            |
| GET    | `/api/tasks/:id/artifacts`    | Get artifacts                           |
| GET    | `/api/tasks/:id/comments`     | Get comments                            |
| POST   | `/api/tasks/:id/comments`     | Add comment                             |
| GET    | `/api/tasks/:id/dependencies` | Get dependencies                        |
| GET    | `/api/dependencies`           | All dependencies                        |
| GET    | `/api/pipeline`               | Pipeline stages                         |
| GET    | `/api/overview`               | Full state dump                         |
| GET    | `/api/agents`                 | Online agents (proxied from agent-comm) |
| GET    | `/api/search?q=`              | Full-text search                        |

## Configuration

| Variable                   | Description                                          | Default                         |
| -------------------------- | ---------------------------------------------------- | ------------------------------- |
| `AGENT_TASKS_DB`           | SQLite database path                                 | `~/.agent-tasks/agent-tasks.db` |
| `AGENT_TASKS_PORT`         | Dashboard HTTP port                                  | `3422`                          |
| `AGENT_TASKS_INSTRUCTIONS` | Set to `0` to disable response-embedded instructions | enabled                         |
| `AGENT_COMM_URL`           | Agent-comm REST URL for bridge notifications         | `http://localhost:3421`         |

## Architecture

```
src/
  context.ts          DI root — wires all services
  index.ts            MCP entry point (stdio JSON-RPC)
  server.ts           HTTP + WebSocket server
  domain/
    tasks.ts          Pipeline logic, CRUD, search, subtasks
    comments.ts       Threaded comments
    collaborators.ts  Multi-agent collaboration
    approvals.ts      Stage-gated approvals
    agent-bridge.ts   Agent-comm notification bridge
    rules.ts          IDE rule generation
    events.ts         In-process event bus
    validate.ts       Input validation constants
  storage/
    database.ts       SQLite (WAL, schema versioning, FK cascades)
  transport/
    mcp.ts            33 MCP tool definitions + dispatch
    rest.ts           15 REST endpoints + static file serving
    ws.ts             WebSocket event streaming + livereload
  ui/
    index.html        Dashboard (vanilla HTML)
    app.js            Kanban client (vanilla JS, no framework)
    styles.css        Light/dark theme, responsive
```

## Development

```bash
npm run dev          # TypeScript watch mode
npm run start:server # Start dashboard on :3422
npm test             # Run 109 tests
npm run check        # typecheck + lint + format + test
```

## License

MIT
