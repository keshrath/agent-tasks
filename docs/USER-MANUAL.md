# agent-tasks User Manual

## Table of Contents

1. [Overview](#1-overview)
2. [Installation](#2-installation)
3. [Configuration](#3-configuration)
4. [Dashboard Guide](#4-dashboard-guide)
5. [MCP Tools Reference](#5-mcp-tools-reference)
6. [REST API Reference](#6-rest-api-reference)
7. [Pipeline Stages and Task Lifecycle](#7-pipeline-stages-and-task-lifecycle)
8. [Troubleshooting](#8-troubleshooting)
9. [FAQ](#9-faq)

---

## 1. Overview

### What agent-tasks Does

agent-tasks is an MCP (Model Context Protocol) server that provides pipeline-driven task management for AI coding agents. Instead of flat todo lists, tasks flow through configurable stages with dependency tracking, approval workflows, and multi-agent collaboration:

- **Pipeline stages** -- tasks move through `backlog > spec > plan > implement > test > review > done`, configurable per project.
- **Task dependencies** -- DAG with automatic cycle detection. Blocks advancement until dependencies are resolved.
- **Approval workflows** -- stage-gated approve/reject with auto-regress on rejection.
- **Multi-agent collaboration** -- roles (collaborator, reviewer, watcher), claiming, assignment.
- **Subtask hierarchies** -- parent/child task trees with progress tracking.
- **Threaded comments** -- async discussions between agents on any task.
- **Artifact versioning** -- per-stage document attachments with automatic versioning.
- **Decisions and learnings** -- structured decision records and insight propagation.
- **Full-text search** -- FTS5 search across task titles and descriptions.
- **Stage gates** -- configurable per-project rules requiring named artifacts, minimum artifact counts, comments, or approvals before advancing.
- **Agent affinity** -- `task_list(next: true)` prefers routing tasks to agents with related history.
- **Real-time kanban dashboard** -- drag-and-drop, side panel, inline creation, dark/light theme.
- **TodoWrite bridge** -- intercepts Claude Code's built-in TodoWrite and syncs to the pipeline.
- **Heartbeat-based cleanup** -- auto-fails tasks from dead agents using agent-comm heartbeat data.

### Architecture

agent-tasks has two entry points:

| Entry Point      | File             | Purpose                                                                                   |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| MCP stdio server | `dist/index.js`  | Communicates with the AI agent via JSON-RPC over stdin/stdout. Auto-starts the dashboard. |
| HTTP server      | `dist/server.js` | Standalone dashboard + REST API + WebSocket.                                              |

Internally:

```
domain/      Tasks (stages, dependencies, artifacts, claiming), events, validation
storage/     SQLite via better-sqlite3 (WAL mode, schema V5)
transport/   REST (node:http), WebSocket (ws), MCP (stdio JSON-RPC)
ui/          Vanilla JS kanban dashboard (no build step for the UI)
```

No framework dependencies -- no Express, no React. Pure Node.js + TypeScript.

---

## 2. Installation

### Prerequisites

- **Node.js 20.11.0 or later**
- **npm** (comes with Node.js)

### From npm

```bash
npm install -g agent-tasks
```

### From Source

```bash
git clone https://github.com/keshrath/agent-tasks.git
cd agent-tasks
npm install
npm run build
```

### npx (No Installation)

```bash
npx agent-tasks
```

---

## 3. Configuration

### Environment Variables

| Variable                   | Default                         | Description                                          |
| -------------------------- | ------------------------------- | ---------------------------------------------------- |
| `AGENT_TASKS_DB`           | `~/.agent-tasks/agent-tasks.db` | SQLite database file path                            |
| `AGENT_TASKS_PORT`         | `3422`                          | Dashboard HTTP/WebSocket port                        |
| `AGENT_TASKS_INSTRUCTIONS` | enabled                         | Set to `0` to disable response-embedded instructions |
| `AGENT_COMM_URL`           | `http://localhost:3421`         | Agent-comm REST URL for bridge notifications         |

### Claude Code Setup

Add agent-tasks to your MCP configuration in `~/.claude.json`:

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

### Permissions (settings.json)

```json
{
  "permissions": {
    "allow": ["mcp__agent-tasks__*"]
  }
}
```

### Other MCP Clients

Any MCP client supporting stdio transport can connect. Configure it to spawn `npx agent-tasks` as the server process.

---

## 4. Dashboard Guide

### Accessing the Dashboard

The dashboard is available at **http://localhost:3422** (or the port configured via `AGENT_TASKS_PORT`).

### Kanban Board

The main view is a kanban board with one column per pipeline stage. Tasks appear as cards that can be dragged between columns to change their stage.

Each task card shows:

- **Title** and **priority** indicator.
- **Assignee** badge (purple tag).
- **Project** badge (accent-colored tag).
- **Artifact count** badge (blue).
- **Blocked indicator** (red) when dependencies are unmet.
- **Subtask progress** bar when the task has children.

### Side Panel

Click a task card to open the side panel. The panel shows:

- Full task details (title, description, status, stage, priority, project, tags).
- **Artifacts** tab -- attached documents, decisions, and learnings with version history.
- **Comments** tab -- threaded discussion.
- **Dependencies** tab -- blocking and related tasks.
- **Collaborators** tab -- assigned agents with roles.

### Inline Task Creation

Click the "+" button at the top of any column to create a task directly in that stage.

### Filtering and Search

Use the filter bar to narrow by project, assignee, status, or full-text query.

### Theme Toggle

Dark and light themes are available. The preference persists in `localStorage`.

### Real-Time Updates

The dashboard connects via WebSocket. The server polls the SQLite database every 2 seconds for changes made by other processes (MCP stdio servers). This ensures the kanban board stays in sync even when tasks are modified via MCP tools in separate sessions.

---

## 5. MCP Tools Reference

agent-tasks exposes 14 MCP tools organized by function.

### task_create

Create a pipeline task. Tasks start in `backlog` by default.

**Parameters:**

| Name          | Type     | Required | Description                                                            |
| ------------- | -------- | -------- | ---------------------------------------------------------------------- |
| `title`       | string   | Yes      | Task title (max 500 chars)                                             |
| `description` | string   | No       | Detailed instructions (max 50K chars)                                  |
| `assign_to`   | string   | No       | Agent name to assign to                                                |
| `stage`       | string   | No       | Initial pipeline stage (default: backlog)                              |
| `priority`    | number   | No       | Priority -- higher number = more important (default: 0)                |
| `project`     | string   | No       | Project name for grouping                                              |
| `tags`        | string[] | No       | Tags for categorization                                                |
| `parent_id`   | number   | No       | Parent task ID -- creates a subtask that inherits project and priority |

**Example:**

```
task_create with title "Implement auth module", project "backend", priority 10, tags ["security"]
task_create with title "Write unit tests", parent_id 42
```

---

### task_get

Get a single task by ID with full details including artifact count, comment count, dependencies, and collaborators.

**Parameters:**

| Name      | Type   | Required | Description         |
| --------- | ------ | -------- | ------------------- |
| `task_id` | number | Yes      | Task ID to retrieve |

**Example:**

```
task_get with task_id 42
```

---

### task_list

List, search, or pick tasks.

**Parameters:**

| Name           | Type    | Required | Description                                                                    |
| -------------- | ------- | -------- | ------------------------------------------------------------------------------ |
| `query`        | string  | No       | Full-text search across titles and descriptions (FTS5)                         |
| `next`         | boolean | No       | Return the single best available task (highest priority, unassigned, deps met) |
| `agent`        | string  | No       | Agent name for affinity scoring (only with next: true)                         |
| `status`       | string  | No       | Filter: `pending`, `in_progress`, `completed`, `failed`, `cancelled`           |
| `assign_to`    | string  | No       | Filter by assigned agent name                                                  |
| `stage`        | string  | No       | Filter by pipeline stage                                                       |
| `project`      | string  | No       | Filter by project                                                              |
| `collaborator` | string  | No       | Filter tasks where agent is a collaborator                                     |
| `root_only`    | boolean | No       | Only show top-level tasks (no subtasks)                                        |
| `parent_id`    | number  | No       | Filter subtasks of a specific parent                                           |
| `limit`        | number  | No       | Max results (default: 500 for list, 50 for search)                             |
| `offset`       | number  | No       | Skip first N results (for pagination)                                          |

**Examples:**

```
task_list
task_list with project "backend", status "in_progress"
task_list with query "authentication"
task_list with next true, agent "my-agent"
```

---

### task_claim

Claim a pending task. Assigns it to you and advances from backlog to spec.

**Parameters:**

| Name      | Type   | Required | Description                                        |
| --------- | ------ | -------- | -------------------------------------------------- |
| `task_id` | number | Yes      | Task ID to claim                                   |
| `claimer` | string | No       | Agent name claiming (uses session name if omitted) |

**Example:**

```
task_claim with task_id 42
```

---

### task_update

Update task metadata. Does not change stage or status (use `task_stage` for that).

**Parameters:**

| Name          | Type     | Required | Description                             |
| ------------- | -------- | -------- | --------------------------------------- |
| `task_id`     | number   | Yes      | Task ID                                 |
| `title`       | string   | No       | New title                               |
| `description` | string   | No       | New description                         |
| `priority`    | number   | No       | New priority                            |
| `project`     | string   | No       | New project                             |
| `tags`        | string[] | No       | New tags                                |
| `assign_to`   | string   | No       | New assignee (empty string to unassign) |

**Example:**

```
task_update with task_id 42, priority 20, tags ["urgent", "security"]
```

---

### task_delete

Delete a task and all its artifacts, comments, and dependencies (cascading). Cannot be undone.

**Parameters:**

| Name      | Type   | Required | Description       |
| --------- | ------ | -------- | ----------------- |
| `task_id` | number | Yes      | Task ID to delete |

---

### task_comment

Add a comment to a task. Supports threading via `parent_comment_id`. Comments also satisfy stage-gate `require_comment` checks.

**Parameters:**

| Name                | Type   | Required | Description                       |
| ------------------- | ------ | -------- | --------------------------------- |
| `task_id`           | number | Yes      | Task ID                           |
| `content`           | string | Yes      | Comment text                      |
| `parent_comment_id` | number | No       | Reply to this comment (threading) |

**Example:**

```
task_comment with task_id 42, content "Test coverage looks good, 94% on auth module"
```

---

### task_stage

Move a task through its lifecycle.

**Parameters:**

| Name      | Type   | Required | Description                                                                      |
| --------- | ------ | -------- | -------------------------------------------------------------------------------- |
| `action`  | string | Yes      | One of: `advance`, `regress`, `complete`, `fail`, `cancel`                       |
| `task_id` | number | Yes      | Task ID                                                                          |
| `stage`   | string | No       | Target stage (advance: optional, advances to next if omitted; regress: required) |
| `comment` | string | No       | Comment (advance: optional, satisfies stage-gate require_comment check)          |
| `reason`  | string | No       | Reason for regression, failure, or cancellation                                  |
| `result`  | string | No       | Result summary (complete) or error description (fail)                            |

**Examples:**

```
task_stage with action "advance", task_id 42
task_stage with action "advance", task_id 42, stage "implement", comment "Spec approved"
task_stage with action "regress", task_id 42, stage "plan", reason "Missing error handling"
task_stage with action "complete", task_id 42, result "Auth module implemented with JWT + refresh tokens"
task_stage with action "fail", task_id 42, result "CI pipeline broken, cannot test"
task_stage with action "cancel", task_id 42, reason "Requirements changed"
```

**Error cases:**

- Unmet dependencies block advancement.
- Stage gate requirements (artifacts, comments, approvals) must be satisfied.
- Cannot advance past the last stage (use `complete` instead).

---

### task_query

Read task-related data.

**Parameters:**

| Name      | Type   | Required | Description                                                       |
| --------- | ------ | -------- | ----------------------------------------------------------------- |
| `type`    | string | Yes      | One of: `subtasks`, `artifacts`, `comments`                       |
| `task_id` | number | Yes      | Task ID                                                           |
| `stage`   | string | No       | Filter artifacts by stage (only with type: "artifacts")           |
| `limit`   | number | No       | Max comments to return (only with type: "comments", default: 100) |

**Examples:**

```
task_query with type "subtasks", task_id 42
task_query with type "artifacts", task_id 42, stage "implement"
task_query with type "comments", task_id 42
```

---

### task_artifact

Attach artifacts to a task. Three types are supported.

**Parameters:**

| Name       | Type   | Required | Description                                                                       |
| ---------- | ------ | -------- | --------------------------------------------------------------------------------- |
| `type`     | string | Yes      | One of: `general`, `decision`, `learning`                                         |
| `task_id`  | number | Yes      | Task ID                                                                           |
| `name`     | string | No       | Artifact name (type: general, e.g. "spec", "test-results", "review-notes")        |
| `content`  | string | No       | Artifact content (type: general: max 100K; type: learning: the insight)           |
| `stage`    | string | No       | Stage to attach to (type: general, defaults to current stage)                     |
| `chose`    | string | No       | What was chosen (type: decision)                                                  |
| `over`     | string | No       | Alternatives considered (type: decision)                                          |
| `because`  | string | No       | Rationale (type: decision)                                                        |
| `category` | string | No       | Learning category: `technique`, `pitfall`, `decision`, `pattern` (type: learning) |

**Examples:**

```
# General artifact
task_artifact with type "general", task_id 42, name "spec", content "## Auth Module Spec\n..."

# Decision record
task_artifact with type "decision", task_id 42, chose "JWT with refresh tokens", over "Session cookies, OAuth2 only", because "Stateless, works with mobile clients"

# Learning
task_artifact with type "learning", task_id 42, content "better-sqlite3 WAL mode needs explicit checkpoint for large transactions", category "pitfall"
```

**Behavior:**

- General artifacts auto-version -- re-attaching the same name at the same stage creates a new version.
- Learnings auto-propagate to parent and sibling tasks when the task is completed.

---

### task_config

Configuration and admin operations.

**Parameters:**

| Name              | Type     | Required | Description                                                          |
| ----------------- | -------- | -------- | -------------------------------------------------------------------- |
| `action`          | string   | Yes      | One of: `session`, `pipeline`, `cleanup`, `rules`                    |
| `project`         | string   | No       | Project name (pipeline: scope, rules: project-specific)              |
| `stages`          | string[] | No       | Stage names in order (pipeline set mode)                             |
| `gate_config`     | object   | No       | Stage-gate config (pipeline only, see below)                         |
| `id`              | string   | No       | Session ID (session only)                                            |
| `name`            | string   | No       | Session name (session only)                                          |
| `mode`            | string   | No       | Cleanup mode: `retention`, `stale_agents`, `all` (cleanup only)      |
| `timeout_minutes` | number   | No       | Heartbeat timeout for stale detection (cleanup only, default: 30)    |
| `format`          | string   | No       | Output format for rules: `mdc` (Cursor) or `claude_md` (Claude Code) |

**Action: session**

Set agent identity for the current MCP session. Call this first so the session name appears in task assignments and comments.

```
task_config with action "session", name "auth-developer"
```

**Action: pipeline**

Get or set pipeline stages and gate configuration for a project.

```
# Get current pipeline config
task_config with action "pipeline"
task_config with action "pipeline", project "backend"

# Set custom stages
task_config with action "pipeline", project "backend", stages ["backlog", "design", "build", "test", "deploy"]

# Set gate config
task_config with action "pipeline", project "backend", gate_config {"require_comment": true, "gates": {"test": {"require_artifacts": ["test-results"]}}}
```

**Gate config structure:**

| Field              | Type     | Description                                                     |
| ------------------ | -------- | --------------------------------------------------------------- |
| `require_comment`  | boolean  | Require at least one comment before advancing (default: false)  |
| `require_artifact` | boolean  | Require at least one artifact at current stage (default: false) |
| `exempt_stages`    | string[] | Stages exempt from gate checks (e.g. ["backlog"])               |
| `gates`            | object   | Per-stage rules (see below)                                     |

Per-stage gate rules:

| Field                   | Type     | Description                                      |
| ----------------------- | -------- | ------------------------------------------------ |
| `require_artifacts`     | string[] | Named artifacts that must exist before advancing |
| `require_min_artifacts` | number   | Minimum artifact count required                  |
| `require_comment`       | boolean  | Require at least one comment                     |
| `require_approval`      | boolean  | Require an approved approval                     |

**Action: cleanup**

Purge old completed tasks or stale agent tasks.

```
task_config with action "cleanup"
task_config with action "cleanup", mode "stale_agents", timeout_minutes 60
task_config with action "cleanup", mode "all"
```

**Action: rules**

Generate IDE rule files for task pipeline usage.

```
task_config with action "rules", format "claude_md"
task_config with action "rules", format "mdc", project "backend"
```

---

### task_dependency

Manage task dependencies.

**Parameters:**

| Name           | Type   | Required | Description                                                  |
| -------------- | ------ | -------- | ------------------------------------------------------------ |
| `action`       | string | Yes      | One of: `add`, `remove`                                      |
| `task_id`      | number | Yes      | Task that depends on another                                 |
| `depends_on`   | number | Yes      | Task that must complete first (blocks) or related task       |
| `relationship` | string | No       | `blocks`, `related`, `duplicate` (default: blocks, add only) |

**Examples:**

```
task_dependency with action "add", task_id 42, depends_on 41
task_dependency with action "add", task_id 42, depends_on 43, relationship "related"
task_dependency with action "remove", task_id 42, depends_on 41
```

**Error cases:**

- Circular dependency detected -- adding a dependency that would create a cycle is rejected.

---

### task_collaborator

Manage task collaborators.

**Parameters:**

| Name       | Type   | Required | Description                                                             |
| ---------- | ------ | -------- | ----------------------------------------------------------------------- |
| `action`   | string | Yes      | One of: `add`, `remove`                                                 |
| `task_id`  | number | Yes      | Task ID                                                                 |
| `agent_id` | string | Yes      | Agent name or ID                                                        |
| `role`     | string | No       | `collaborator`, `reviewer`, `watcher` (default: collaborator, add only) |

**Examples:**

```
task_collaborator with action "add", task_id 42, agent_id "reviewer-agent", role "reviewer"
task_collaborator with action "remove", task_id 42, agent_id "reviewer-agent"
```

---

### task_approval

Manage approval workflows for stage gates.

**Parameters:**

| Name          | Type   | Required | Description                                                  |
| ------------- | ------ | -------- | ------------------------------------------------------------ |
| `action`      | string | Yes      | One of: `request`, `approve`, `reject`, `list`, `review`     |
| `task_id`     | number | Varies   | Task ID (required for request and review)                    |
| `approval_id` | number | Varies   | Approval ID (required for approve and reject)                |
| `stage`       | string | No       | Stage requiring approval (request only, defaults to current) |
| `reviewer`    | string | No       | Reviewer to assign (request) or filter by (list)             |
| `comment`     | string | No       | Comment (optional for approve, required for reject)          |
| `decision`    | string | No       | `approve` or `reject` (review action)                        |
| `reason`      | string | No       | Rejection reason (required for review+reject)                |
| `regress_to`  | string | No       | Stage to regress to on rejection (default: implement)        |

**Examples:**

```
# Request approval
task_approval with action "request", task_id 42, reviewer "lead-dev"

# Approve
task_approval with action "approve", approval_id 1, comment "Looks good"

# Reject with regression
task_approval with action "reject", approval_id 1, comment "Needs error handling", regress_to "implement"

# Convenience: review = approve+advance or reject+regress in one call
task_approval with action "review", task_id 42, decision "approve"
task_approval with action "review", task_id 42, decision "reject", reason "Missing tests", regress_to "implement"

# List pending
task_approval with action "list"
task_approval with action "list", reviewer "lead-dev"
```

---

## 6. REST API Reference

All endpoints return JSON. CORS enabled. Rate limited to 100 requests per minute per IP.

### Health and Overview

```
GET  /health                          Health check with version, uptime, task count
GET  /api/overview                    Full state dump (tasks, dependencies, artifact counts, comment counts, subtask progress, stages)
                                      Query params: ?limit=100&offset=0
```

### Tasks

```
GET  /api/tasks                       List tasks
                                      Query params: ?status=&stage=&project=&assigned_to=&limit=
GET  /api/tasks/:id                   Get a single task
POST /api/tasks                       Create a task (body: {title, description?, priority?, project?, tags?, parent_id?, assign_to?, stage?})
PUT  /api/tasks/:id                   Update task fields (body: {title?, description?, priority?, project?, tags?, assigned_to?})
PUT  /api/tasks/:id/stage             Change stage (body: {stage, reason?})
GET  /api/tasks/:id/subtasks          Subtasks of a parent
GET  /api/tasks/:id/artifacts         Artifacts (query: ?stage=)
POST /api/tasks/:id/artifacts         Add artifact (body: {name, content, created_by?, stage?})
GET  /api/tasks/:id/comments          Comments on a task
POST /api/tasks/:id/comments          Add comment (body: {content, agent_id?, parent_comment_id?})
GET  /api/tasks/:id/dependencies      Dependencies for a task
```

### Dependencies and Pipeline

```
GET  /api/dependencies                All dependencies across all tasks
GET  /api/pipeline                    Pipeline stage configuration (?project=)
```

### Search and Agents

```
GET  /api/search?q=                   Full-text search (?project=&limit=)
GET  /api/agents                      Online agents (from agent-comm bridge)
```

### Cleanup

```
POST /api/cleanup                     Trigger cleanup (body: {all?: boolean, force?: boolean})
```

### Example Requests

```bash
# Health check
curl http://localhost:3422/health

# List tasks for a project
curl "http://localhost:3422/api/tasks?project=backend&status=in_progress"

# Create a task
curl -X POST http://localhost:3422/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Fix login bug","project":"backend","priority":5}'

# Advance stage
curl -X PUT http://localhost:3422/api/tasks/42/stage \
  -H "Content-Type: application/json" \
  -d '{"stage":"implement"}'

# Search
curl "http://localhost:3422/api/search?q=authentication"
```

---

## 7. Pipeline Stages and Task Lifecycle

### Default Pipeline

The default pipeline has 7 stages:

```
backlog --> spec --> plan --> implement --> test --> review --> done
```

Tasks move forward through stages via `task_stage(action: "advance")` and can be regressed to earlier stages via `task_stage(action: "regress")`.

### Custom Pipelines

Each project can have its own pipeline stages:

```
task_config with action "pipeline", project "frontend", stages ["backlog", "design", "build", "qa", "deploy"]
```

### Task Status vs Stage

Tasks have both a **status** and a **stage**:

- **Status** tracks the overall lifecycle: `pending` (created), `in_progress` (claimed), `completed`, `failed`, `cancelled`.
- **Stage** tracks the pipeline position: `backlog`, `spec`, `plan`, `implement`, `test`, `review`, `done`.

Status transitions:

- `pending` -> `in_progress` (via `task_claim`)
- `in_progress` -> `completed` (via `task_stage(action: "complete")`)
- `in_progress` -> `failed` (via `task_stage(action: "fail")`)
- Any non-terminal -> `cancelled` (via `task_stage(action: "cancel")`)

### Dependencies

Dependencies enforce ordering between tasks. A task with a `blocks` dependency cannot advance past `backlog` until the blocking task is completed.

Relationship types:

| Type        | Behavior                                        |
| ----------- | ----------------------------------------------- |
| `blocks`    | Blocks advancement until the dependency is done |
| `related`   | Informational link, does not block              |
| `duplicate` | Marks tasks as duplicates                       |

Cycle detection prevents circular dependencies.

### Stage Gates

Stage gates enforce quality checks before advancement. Configure them per project:

```
task_config with action "pipeline", project "backend", gate_config {
  "require_comment": true,
  "exempt_stages": ["backlog"],
  "gates": {
    "test": {
      "require_artifacts": ["test-results"],
      "require_min_artifacts": 1
    },
    "review": {
      "require_approval": true
    }
  }
}
```

When a stage gate is not satisfied, `task_stage(action: "advance")` returns an error listing the unmet requirements.

### Agent Affinity

When using `task_list(next: true, agent: "my-agent")`, the system scores available tasks by affinity:

- Higher score for tasks where the agent worked on the parent task.
- Higher score for tasks where the agent worked on a dependency.
- Higher score for tasks in projects the agent has worked on before.

This is a tie-breaker when multiple tasks have the same priority.

### Learnings Propagation

Learnings attached via `task_artifact(type: "learning")` are automatically propagated to parent and sibling tasks when the task is completed. This allows insights discovered during implementation to flow upward and across the task tree.

---

## 8. Troubleshooting

### Dashboard Won't Start

**Symptom:** Port 3422 already in use.

**Solutions:**

1. Set `AGENT_TASKS_PORT=3423` in the MCP config env.
2. Find and stop the process using port 3422.
3. Multiple MCP instances share the same database. Only one needs to serve the dashboard.

### Task Cannot Be Advanced

**Symptom:** `task_stage(action: "advance")` returns an error.

**Common causes:**

- **Unmet dependencies**: A blocking task is not yet completed. Check dependencies with `task_query(type: "subtasks")` or `task_dependency`.
- **Stage gate requirements**: Required artifacts, comments, or approvals are missing. The error message lists unmet requirements.
- **Task not in progress**: Only `in_progress` tasks can be advanced. Claim the task first with `task_claim`.

### Stale Tasks

**Symptom:** Tasks remain assigned to agents that are no longer running.

**Solutions:**

- If agent-comm is running, heartbeat-based cleanup automatically fails tasks from dead agents.
- Manual cleanup: `task_config(action: "cleanup", mode: "stale_agents", timeout_minutes: 30)`.
- Session hooks auto-fail orphaned tasks on session stop and clean up stale tasks on session start.

### Database Issues

**Symptom:** SQLite errors.

**Solutions:**

- The database is at `~/.agent-tasks/agent-tasks.db` by default (configurable via `AGENT_TASKS_DB`).
- If corrupted, delete the database and WAL files. All task data will be lost.
- The database uses WAL mode with schema versioning (currently V5). Migrations run automatically on startup.

### Dashboard Shows Stale Data

**Symptom:** Kanban board not reflecting recent changes.

**Cause:** The dashboard polls the database every 2 seconds. Changes made via MCP appear within about 2 seconds.

**Solutions:**

- Wait a few seconds for the poll cycle.
- Refresh the browser page.
- Check WebSocket connection in browser dev tools.

---

## 9. FAQ

### Can I use this with Cursor/OpenCode?

Yes. agent-tasks is a standard MCP server. Any MCP-compatible client can use it.

### How does it integrate with agent-comm?

agent-tasks optionally connects to agent-comm via `AGENT_COMM_URL`. This enables:

- **Heartbeat-based cleanup**: Detects when agents die and auto-fails their tasks.
- **Bridge notifications**: Notifies connected agents on task events.
- **Agent list**: The `/api/agents` endpoint fetches live agent data from agent-comm.

Without agent-comm, these features are gracefully skipped.

### What is the TodoWrite bridge?

When configured via hooks, agent-tasks intercepts Claude Code's built-in `TodoWrite` tool calls and syncs them to the pipeline. Todos become tasks in the kanban board.

### Can multiple agents work on the same task?

Yes, via collaborators. Use `task_collaborator(action: "add")` to add agents with roles:

- **collaborator**: Can work on the task.
- **reviewer**: Reviews artifacts.
- **watcher**: Gets notifications but does not participate.

### How do I reset the pipeline?

Delete and recreate the pipeline stages for a project:

```
task_config with action "pipeline", project "my-project", stages ["backlog", "spec", "plan", "implement", "test", "review", "done"]
```

### What happens to subtasks when a parent is completed?

Subtasks have independent lifecycles. Completing a parent does not auto-complete subtasks. The kanban board shows subtask progress as a percentage bar on the parent card.

### How do I find the next available task?

```
task_list with next true
```

This returns the single highest-priority unassigned task with all dependencies met. Add `agent: "my-name"` for affinity-based routing.

### Where is the database stored?

Default: `~/.agent-tasks/agent-tasks.db`. Override with `AGENT_TASKS_DB` environment variable. The database uses WAL mode and FK constraints with cascading deletes.
