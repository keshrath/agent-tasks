# agent-tasks

Pipeline-driven task management for AI coding agents. An [MCP](https://modelcontextprotocol.io/) server that provides stage-gated task pipelines with dependencies, artifacts, and multi-agent claiming.

Part of the **agent-\*** family: [`agent-comm`](https://gitlab.mukit.at/development/agent-comm) (messaging) + `agent-tasks` (pipeline).

## Features

- **Pipeline stages** — tasks flow through configurable stages: `backlog → spec → plan → implement → test → review → done`
- **Dependencies** — tasks can depend on other tasks; advancement is blocked until dependencies are met (with cycle detection)
- **Artifacts** — attach specs, plans, test results, review notes to tasks at each stage
- **Multi-agent claiming** — agents claim tasks from a shared queue; highest-priority unblocked task is served first
- **Per-project pipelines** — customize stage definitions per project
- **SQLite storage** — WAL-mode SQLite via better-sqlite3 for concurrent access

## Quick Start

```bash
npm install
npm run build
```

### As an MCP server (stdio)

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

## Tools

| Tool                     | Description                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| `task_create`            | Create a task with title, description, stage, priority, project, tags     |
| `task_list`              | List tasks with filters (status, assignee, stage, project) and pagination |
| `task_claim`             | Claim a pending task — assigns it and advances from backlog               |
| `task_complete`          | Mark a task as completed with a result                                    |
| `task_fail`              | Mark a task as failed with an error                                       |
| `task_cancel`            | Cancel a task                                                             |
| `task_advance`           | Advance to the next (or a specific) stage; checks dependencies            |
| `task_regress`           | Send a task back to an earlier stage (e.g. review rejection)              |
| `task_update`            | Update task metadata (title, description, priority, tags, assignee)       |
| `task_next`              | Get the highest-priority unassigned task with all dependencies met        |
| `task_add_dependency`    | Add a dependency between tasks (with cycle detection)                     |
| `task_remove_dependency` | Remove a dependency                                                       |
| `task_add_artifact`      | Attach a document/artifact to a task at a specific stage                  |
| `task_get_artifacts`     | Retrieve artifacts for a task                                             |
| `task_pipeline_config`   | Get or set pipeline stages for a project                                  |
| `task_set_session`       | Set the session identity for tracking who creates/claims tasks            |

## Configuration

| Environment Variable | Description                          | Default                    |
| -------------------- | ------------------------------------ | -------------------------- |
| `AGENT_TASKS_DB`     | Path to SQLite database              | `~/.claude/agent-tasks.db` |
| `AGENT_TASKS_TEST`   | Use in-memory database (for testing) | —                          |

## Development

```bash
npm run dev          # watch mode
npm test             # run tests
npm run check        # typecheck + lint + format + test
```

## License

MIT
