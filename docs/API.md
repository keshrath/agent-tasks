# API Reference

agent-tasks exposes three transport layers: MCP (stdio), REST (HTTP), and WebSocket (real-time events).

## MCP Tools (32)

### Task lifecycle

| Tool            | Description                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `task_create`   | Create a pipeline task (title, description, priority, project, tags, parent_id)                 |
| `task_list`     | List tasks with filters (status, stage, project, assignee, collaborator, root_only, pagination) |
| `task_next`     | Get the highest-priority unassigned unblocked task                                              |
| `task_claim`    | Claim a pending task — assigns it and advances from backlog                                     |
| `task_advance`  | Advance to the next pipeline stage (validates dependencies)                                     |
| `task_regress`  | Regress to an earlier stage with a reason artifact                                              |
| `task_complete` | Mark a task completed with a result summary                                                     |
| `task_fail`     | Mark a task failed with an error description                                                    |
| `task_cancel`   | Cancel a task with a reason                                                                     |
| `task_update`   | Update metadata (title, description, priority, tags, assignee)                                  |
| `task_delete`   | Delete a task with cascading cleanup of subtasks, comments, artifacts                           |
| `task_search`   | Full-text search across task titles and descriptions                                            |

### Subtasks & dependencies

| Tool                     | Description                                                |
| ------------------------ | ---------------------------------------------------------- |
| `task_expand`            | Break a task into subtasks (inherits project and priority) |
| `task_get_subtasks`      | Get child tasks of a parent                                |
| `task_add_dependency`    | Add a dependency between tasks (with cycle detection)      |
| `task_remove_dependency` | Remove a dependency                                        |

### Artifacts

| Tool                 | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `task_add_artifact`  | Attach a document to a task with automatic versioning              |
| `task_get_artifacts` | Retrieve artifacts for a task (filter by stage)                    |
| `task_decision`      | Record a structured decision (chose, over, because) as an artifact |

### Comments

| Tool                | Description                      |
| ------------------- | -------------------------------- |
| `task_comment`      | Add a threaded comment to a task |
| `task_get_comments` | List all comments on a task      |

### Collaboration

| Tool                       | Description                                                |
| -------------------------- | ---------------------------------------------------------- |
| `task_add_collaborator`    | Add an agent with a role (collaborator, reviewer, watcher) |
| `task_remove_collaborator` | Remove a collaborator from a task                          |

### Approvals

| Tool                     | Description                                            |
| ------------------------ | ------------------------------------------------------ |
| `task_request_approval`  | Request stage approval from reviewers                  |
| `task_approve`           | Approve a pending approval                             |
| `task_reject`            | Reject with a required comment                         |
| `task_pending_approvals` | List all pending approvals                             |
| `task_review_cycle`      | Convenience approve/reject with automatic stage change |

### Configuration & utilities

| Tool                   | Description                                                          |
| ---------------------- | -------------------------------------------------------------------- |
| `task_pipeline_config` | Get or set pipeline stages and gate guards per project               |
| `task_set_session`     | Set the session identity (agent name)                                |
| `task_cleanup`         | Clean up completed/cancelled tasks (configurable retention)          |
| `task_generate_rules`  | Generate IDE rule files (.mdc for Cursor, CLAUDE.md for Claude Code) |

---

## REST API (19 endpoints)

All endpoints return JSON. CORS is enabled. The server runs on port 3422 by default.

### Read endpoints

| Method | Path                          | Description                                                                                                     |
| ------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                     | Health check with version, uptime, and task count                                                               |
| `GET`  | `/api/tasks`                  | List tasks (query params: `status`, `stage`, `project`, `assigned_to`, `root_only`, `limit`, `offset`)          |
| `GET`  | `/api/tasks/:id`              | Get a single task by ID                                                                                         |
| `GET`  | `/api/tasks/:id/subtasks`     | Get subtasks of a parent task                                                                                   |
| `GET`  | `/api/tasks/:id/artifacts`    | Get artifacts (query: `stage`)                                                                                  |
| `GET`  | `/api/tasks/:id/comments`     | Get comments                                                                                                    |
| `GET`  | `/api/tasks/:id/dependencies` | Get dependencies for a task                                                                                     |
| `GET`  | `/api/dependencies`           | Get all dependencies across all tasks                                                                           |
| `GET`  | `/api/pipeline`               | Get pipeline stage configuration (query: `project`)                                                             |
| `GET`  | `/api/overview`               | Full state dump (tasks, dependencies, artifact counts, comment counts, subtask progress, collaborators, stages) |
| `GET`  | `/api/agents`                 | Online agents (proxied from agent-comm)                                                                         |
| `GET`  | `/api/search?q=`              | Full-text search across tasks                                                                                   |

### Write endpoints

| Method | Path                      | Description                                          |
| ------ | ------------------------- | ---------------------------------------------------- |
| `POST` | `/api/tasks`              | Create a new task                                    |
| `PUT`  | `/api/tasks/:id`          | Update task fields                                   |
| `PUT`  | `/api/tasks/:id/stage`    | Change stage (advance or regress)                    |
| `POST` | `/api/tasks/:id/comments` | Add a comment to a task                              |
| `POST` | `/api/cleanup`            | Trigger manual cleanup (body: `{ "maxAgeDays": 7 }`) |

### Authentication

The REST API is **unauthenticated**. It is designed for localhost use between trusted agents.

### Error responses

```json
{
  "error": "Description of the error"
}
```

| Status | Meaning                                     |
| ------ | ------------------------------------------- |
| 400    | Bad request (missing params, invalid input) |
| 404    | Entity not found                            |
| 409    | Conflict (e.g. dependency cycle)            |
| 422    | Input validation failure                    |
| 500    | Internal server error                       |

---

## WebSocket

Connect to `ws://localhost:3422` for real-time events.

### Connection lifecycle

1. **On connect:** receives a full state snapshot (`type: "state"`) containing tasks, dependencies, pipeline stages, artifact counts, comment counts, subtask progress, and collaborators
2. **Incremental events:** streamed as tasks are created, updated, moved, or deleted
3. **Polling:** the server polls SQLite every 2 seconds to detect cross-process changes (e.g., tasks created via MCP in another terminal)

### Event types

- `state` — full snapshot (sent on initial connection)
- Task CRUD events — streamed when tasks are created, updated, advanced, completed, or deleted

### Cross-process sync

Because MCP servers run as separate stdio processes, the WebSocket server polls the SQLite database every 2 seconds to detect changes made by other processes. This ensures the dashboard stays in sync even when tasks are modified via MCP tools in separate Claude Code sessions.
