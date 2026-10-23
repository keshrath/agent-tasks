# agent-tasks User Manual

## Table of Contents

1. [Overview](#1-overview)
2. [Installation](#2-installation)
3. [Configuration](#3-configuration)
4. [The /pipeline Pane](#4-the-pipeline-pane)
5. [MCP Tools Reference](#5-mcp-tools-reference)
6. [REST API Reference](#6-rest-api-reference)
7. [Pipeline Stages and Task Lifecycle](#7-pipeline-stages-and-task-lifecycle)
8. [Troubleshooting](#8-troubleshooting)
9. [FAQ](#9-faq)

---

## 1. Overview

### What agent-tasks Does

agent-tasks is an MCP (Model Context Protocol) server that provides pipeline-driven task management for AI coding agents. Instead of flat todo lists, tasks flow through configurable stages with dependency tracking, stage gates, and multi-agent claiming:

- **Pipeline stages** -- tasks move through `backlog > spec > plan > implement > test > review > done`, configurable per project.
- **Task dependencies** -- DAG with automatic cycle detection. Blocks advancement until dependencies are resolved.
- **Multi-agent claiming** -- claim, assign, send back to an earlier stage with a reason (recorded as a `rejection` artifact under who sent it back).
- **Subtask hierarchies** -- parent/child task trees with progress tracking.
- **Threaded comments** -- async discussions between agents on any task.
- **Artifact versioning** -- per-stage document attachments with automatic versioning.
- **Decisions and learnings** -- structured decision records and insight propagation.
- **Full-text search** -- FTS5 search across task titles and descriptions.
- **Stage gates** -- configurable per-project rules requiring named artifacts, minimum artifact counts or a comment before advancing. (`require_approval` exists in the schema, but no MCP tool or REST route records an approval, so a stage with it set cannot be left; keep it off.)
- **Agent affinity** -- `task_list(next: true)` prefers routing tasks to agents with related history.
- **Claude Code `/pipeline` pane** -- the board beside the conversation: tasks by stage, task detail, every lifecycle action, a status line entry.
- **TodoWrite bridge** -- intercepts Claude Code's built-in TodoWrite and syncs to the pipeline.
- **Heartbeat-based cleanup** -- auto-fails tasks from dead agents using agent-comm heartbeat data.

### Architecture

agent-tasks has two entry points:

| Entry Point      | File             | Purpose                                                                                  |
| ---------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| MCP stdio server | `dist/index.js`  | Communicates with the AI agent via JSON-RPC over stdin/stdout. Auto-starts the REST API. |
| REST server      | `dist/server.js` | Standalone REST API (what the `/pipeline` pane reads).                                   |

Internally:

```
domain/      Tasks (stages, dependencies, artifacts, claiming), events, validation
storage/     SQLite via better-sqlite3 (WAL mode, schema V5)
transport/   REST (node:http), MCP (stdio JSON-RPC)
plugin/      Claude Code plugin: MCP server config + the /pipeline mod
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

| Variable                                 | Default                         | Description                                                                    |
| ---------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| `AGENT_TASKS_DB`                         | `~/.agent-tasks/agent-tasks.db` | SQLite database file path                                                      |
| `AGENT_TASKS_PORT`                       | `3422`                          | REST API port (the `/pipeline` pane reads it)                                  |
| `AGENT_TASKS_HOST`                       | `127.0.0.1`                     | REST bind address (`0.0.0.0` exposes it to the network)                        |
| `AGENT_TASKS_USER`                       | the OS user                     | Who the `/pipeline` pane acts as (`created_by`, comment author, `by`)          |
| `AGENT_TASKS_INSTRUCTIONS`               | enabled                         | Set to `0` to disable response-embedded instructions                           |
| `AGENT_TASKS_RETENTION_DAYS`             | `30`                            | Days the cleanup keeps resolved approval records                               |
| `AGENT_TASKS_DEAD_SESSION_GRACE_MINUTES` | `60`                            | `task-cleanup-start.js`: idle minutes before a dead session's task is failed   |
| `AGENT_TASKS_HEARTBEAT_FRESH_MINUTES`    | `15`                            | `task-cleanup-start.js`: an agent with a heartbeat this recent counts as alive |
| `AGENT_COMM_URL`                         | `http://localhost:3421`         | Agent-comm REST URL for bridge notifications                                   |
| `AGENT_KNOWLEDGE_URL`                    | `http://localhost:3423`         | Agent-knowledge REST URL for the knowledge bridge                              |

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

The first MCP process also serves the REST API on http://localhost:3422. For the board, install the plugin instead (`claude plugin marketplace add keshrath/agent-tasks`, then `claude plugin install agent-tasks@agent-tasks`): it runs the same MCP server and adds `/pipeline`.

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

## 4. The /pipeline Pane

agent-tasks has no web dashboard (removed in 2.0). With the agent-tasks plugin installed (Claude Code 2.1.289+), `/pipeline` opens the board in a pane beside the conversation (docked in the fullscreen layout, above the prompt otherwise).

- **Board** -- tasks grouped by pipeline stage with counts; markers for priority, assignee and unmet dependencies. Find narrows it by id, title, assignee, project or tag (`/pipeline <text>` opens it narrowed).
- **Task detail** -- the stage strip, status, assignee, project, priority, tags, blocking dependencies, subtasks, description, artifacts per stage and the comment thread, with the lifecycle actions for a task an agent is working on (advance, send back, complete, fail), cancel, comment and delete. Claiming stays with the agents (`task_stage`): an unclaimed task waits for one, and a blocked one offers no Advance or Complete, only what it waits for.
- **Done** -- recently finished tasks with their result; **New** -- a form that creates a task in the first stage.
- **Who acts** -- what you do in the pane is recorded under `AGENT_TASKS_USER`, else your OS user name.
- **Status line** -- the board's summary (`7 open tasks · 3 in progress · 1 blocked`); a toast when a task finishes or reaches review.

The pane is keyboard-first: `Tab` moves the focus, `Enter` presses, `Esc` hands the keyboard back to the prompt. It reads the REST API on `AGENT_TASKS_PORT`; changes from any session show up within one poll.

---

## 5. MCP Tools Reference

agent-tasks exposes **8 action-based MCP tools**. Older releases had 14+ tools; the consolidation merged the per-action tools (`task_claim`, `task_advance`, `task_complete`, `task_fail`, `task_query`, `task_dependency`, `task_collaborator`, `task_approval`, `task_get_subtasks`, etc.) into the action-based tools below to keep prompt overhead minimal.

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

Get a single task by ID with full details. Always returns its artifacts, `comments_count`, `claim_status` and `dependencies`: `blockers` and `blocking` (the `blocks` links) and `links` (`related` / `duplicate`, each `{ task, relationship, direction }`). Optionally include subtasks, comments and the transitive dependency chain in one call.

**Parameters:**

| Name      | Type     | Required | Description                                                                                                      |
| --------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `task_id` | number   | Yes      | Task ID to retrieve                                                                                              |
| `include` | string[] | No       | Any combination of `"subtasks"`, `"artifacts"`, `"comments"`, `"transitive_deps"`                                |
| `stage`   | string   | No       | Filter artifacts by stage (only when `include` contains `"artifacts"`)                                           |
| `limit`   | number   | No       | How many of the newest comments to return, oldest first (only when `include` contains `"comments"`, default 100) |

**Examples:**

```
task_get with task_id 42
task_get with task_id 42, include ["subtasks", "artifacts"]
task_get with task_id 42, include ["artifacts"], stage "implement"
task_get with task_id 42, include ["comments"], limit 50
```

> Replaces the former `task_get_subtasks`, `task_get_artifacts`, `task_get_comments`, and `task_query` tools.

---

### task_list

List, search, or pick tasks.

**Parameters:**

| Name           | Type     | Required | Description                                                                    |
| -------------- | -------- | -------- | ------------------------------------------------------------------------------ |
| `query`        | string   | No       | Full-text search across titles and descriptions (FTS5)                         |
| `next`         | boolean  | No       | Return the single best available task (highest priority, unassigned, deps met) |
| `agent`        | string   | No       | Agent name for affinity scoring (only with next: true)                         |
| `status`       | string   | No       | Filter: `pending`, `in_progress`, `completed`, `failed`, `cancelled`           |
| `assign_to`    | string   | No       | Filter by assigned agent name                                                  |
| `stage`        | string   | No       | Filter by pipeline stage                                                       |
| `project`      | string   | No       | Filter by project                                                              |
| `collaborator` | string   | No       | Filter tasks where agent is a collaborator                                     |
| `root_only`    | boolean  | No       | Only show top-level tasks (no subtasks)                                        |
| `parent_id`    | number   | No       | Filter subtasks of a specific parent                                           |
| `tags`         | string[] | No       | Filter by tags; a task must carry every tag listed                             |
| `limit`        | number   | No       | Max results (default: 500 for list, 50 for search)                             |
| `offset`       | number   | No       | Skip first N results (for pagination)                                          |

**Examples:**

```
task_list
task_list with project "backend", status "in_progress"
task_list with query "authentication"
task_list with next true, agent "my-agent"
```

---

### task_update

Update task metadata. Also handles dependency add/remove inline. Does not change stage or status (use `task_stage` for that).

**Parameters:**

| Name          | Type     | Required | Description                                                                                                                                                              |
| ------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `task_id`     | number   | Yes      | Task ID                                                                                                                                                                  |
| `title`       | string   | No       | New title                                                                                                                                                                |
| `description` | string   | No       | New description                                                                                                                                                          |
| `priority`    | number   | No       | New priority                                                                                                                                                             |
| `project`     | string   | No       | New project                                                                                                                                                              |
| `tags`        | string[] | No       | New tags                                                                                                                                                                 |
| `assign_to`   | string   | No       | New assignee (empty string to unassign)                                                                                                                                  |
| `dependency`  | object   | No       | Add or remove a dependency inline: `{ action: "add"\|"remove", depends_on: <task_id>, relationship?: "blocks"\|"related"\|"duplicate" }` (relationship only used on add) |

**Examples:**

```
task_update with task_id 42, priority 20, tags ["urgent", "security"]
task_update with task_id 42, dependency { action: "add", depends_on: 41 }
task_update with task_id 42, dependency { action: "add", depends_on: 43, relationship: "related" }
task_update with task_id 42, dependency { action: "remove", depends_on: 41 }
```

> Dependency management is part of `task_update`; the former `task_dependency`, `task_add_dependency`, and `task_remove_dependency` tools are gone.

---

### task_delete

Delete a task and all its artifacts, comments, and dependencies (cascading). Cannot be undone.

**Parameters:**

| Name      | Type   | Required | Description       |
| --------- | ------ | -------- | ----------------- |
| `task_id` | number | Yes      | Task ID to delete |

---

### task_stage

Move a task through its lifecycle. All claim/assign/advance/regress/complete/fail/cancel transitions live here.

**Parameters:**

| Name      | Type   | Required | Description                                                                      |
| --------- | ------ | -------- | -------------------------------------------------------------------------------- |
| `action`  | string | Yes      | One of: `claim`, `assign`, `advance`, `regress`, `complete`, `fail`, `cancel`    |
| `task_id` | number | Yes      | Task ID                                                                          |
| `claimer` | string | No       | Agent name claiming (claim only, uses session name if omitted)                   |
| `stage`   | string | No       | Target stage (advance: optional, advances to next if omitted; regress: required) |
| `comment` | string | No       | Comment (advance: optional, satisfies stage-gate require_comment check)          |
| `reason`  | string | No       | Reason for regression or cancellation                                            |
| `result`  | string | No       | Result summary (complete) or error description (fail)                            |

**Examples:**

```
task_stage with action "claim", task_id 42
task_stage with action "advance", task_id 42
task_stage with action "advance", task_id 42, stage "implement", comment "Spec approved"
task_stage with action "regress", task_id 42, stage "plan", reason "Missing error handling"
task_stage with action "complete", task_id 42, result "Auth module implemented with JWT + refresh tokens"
task_stage with action "fail", task_id 42, result "CI pipeline broken, cannot test"
task_stage with action "cancel", task_id 42, reason "Requirements changed"
```

**Error cases:**

- An open `blocks` dependency refuses `advance` and `complete` (claim does not check it).
- Stage gate requirements (artifacts, comments) must be satisfied.
- Cannot advance past the last stage (use `complete` instead).

> Replaces the former `task_claim`, `task_advance`, `task_regress`, `task_complete`, `task_fail`, and `task_cancel` tools.

---

### task_artifact

Attach artifacts or comments to a task. Four types are supported.

**Parameters:**

| Name                | Type   | Required | Description                                                                       |
| ------------------- | ------ | -------- | --------------------------------------------------------------------------------- |
| `type`              | string | Yes      | One of: `general`, `decision`, `learning`, `comment`                              |
| `task_id`           | number | Yes      | Task ID                                                                           |
| `name`              | string | No       | Artifact name (type: general, e.g. "spec", "test-results", "review-notes")        |
| `content`           | string | No       | Artifact content (general: max 100K; learning: the insight; comment: the text)    |
| `stage`             | string | No       | Stage to attach to (type: general, defaults to current stage)                     |
| `chose`             | string | No       | What was chosen (type: decision)                                                  |
| `over`              | string | No       | Alternatives considered (type: decision)                                          |
| `because`           | string | No       | Rationale (type: decision)                                                        |
| `category`          | string | No       | Learning category: `technique`, `pitfall`, `decision`, `pattern` (type: learning) |
| `parent_comment_id` | number | No       | The comment this one replies to (type: comment)                                   |

**Examples:**

```
# General artifact
task_artifact with type "general", task_id 42, name "spec", content "## Auth Module Spec\n..."

# Decision record
task_artifact with type "decision", task_id 42, chose "JWT with refresh tokens", over "Session cookies, OAuth2 only", because "Stateless, works with mobile clients"

# Learning
task_artifact with type "learning", task_id 42, content "better-sqlite3 WAL mode needs explicit checkpoint for large transactions", category "pitfall"

# Comment, and a reply to comment 7
task_artifact with type "comment", task_id 42, content "Is the refresh token rotated?"
task_artifact with type "comment", task_id 42, content "Yes, on every use", parent_comment_id 7
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

| Field                   | Type     | Description                                                              |
| ----------------------- | -------- | ------------------------------------------------------------------------ |
| `require_artifacts`     | string[] | Named artifacts that must exist before advancing                         |
| `require_min_artifacts` | number   | Minimum artifact count required                                          |
| `require_comment`       | boolean  | Require at least one comment                                             |
| `require_approval`      | boolean  | Require an approved approval. No tool records approvals, so leave it off |

**Example: self-review gate**

Enforce that every task gets a review before completion — even when a single agent does all the work. Configure the review stage to require a `review-notes` artifact:

```
task_config({
  action: "pipeline",
  project: "my-project",
  gate_config: {
    gates: {
      "review": { "require_artifacts": ["review-notes"] }
    },
    exempt_stages: ["backlog"]
  }
})
```

Now advancing past the review stage fails unless a `review-notes` artifact exists:

```
task_artifact({ type: "general", task_id: 42, name: "review-notes",
  content: "Re-read diff, ran tests (all pass), verified acceptance criteria met." })
task_stage({ action: "advance", task_id: 42 })
```

This works for both solo and multi-agent workflows. Solo: the implementing agent self-reviews. Multi-agent: a different agent can claim the review stage and attach the artifact.

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

> **Note on removed tools:** earlier releases had separate `task_dependency`, `task_collaborator`, and `task_approval` tools. The dependency tool was folded into `task_update` (see above). The `task_collaborator` and `task_approval` tools were removed entirely — the workflows they covered (multi-reviewer approvals, role-based collaboration) proved unused. If you need them back, they're recoverable from git history but consider whether the simpler stage-gate model in `task_config { action: "pipeline" }` is enough.

---

## 6. REST API Reference

All endpoints return JSON. Loopback only: a foreign `Host` header gets 403, so does any request carrying an `Origin` header (loopback origins included), request bodies must be `application/json`, no wildcard CORS.

Eight routes: what the `/pipeline` pane and the hook scripts call. Everything else goes through the MCP tools.

```
GET    /health                        Health check with version, uptime, task count
GET    /api/board                     Open tasks, recently closed ones (?recent=30), pipelines, dependencies, subtask progress
GET    /api/pipeline                  Pipeline stages and gate config (?project=)
GET    /api/tasks/:id                 One task as task_get (?include=subtasks,comments,transitive_deps; newest 100 comments)
POST   /api/tasks                     Create a task (body: {title, description?, priority?, project?, tags?, parent_id?, assign_to?, stage?, created_by?})
POST   /api/tasks/:id/stage           Lifecycle action (body: {action, stage?, comment?, reason?, result?, claimer?, by?})
POST   /api/tasks/:id/comments        Add comment (body: {content, agent_id?, parent_comment_id?})
DELETE /api/tasks/:id                 Delete a task
```

### Example Requests

```bash
# Health check
curl http://localhost:3422/health

# One task with its subtasks and comments
curl "http://localhost:3422/api/tasks/42?include=subtasks,comments"

# Create a task
curl -X POST http://localhost:3422/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Fix login bug","project":"backend","priority":5}'

# Advance stage
curl -X POST http://localhost:3422/api/tasks/42/stage \
  -H "Content-Type: application/json" \
  -d '{"action":"advance","by":"me"}'
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

- `pending` -> `in_progress` (via `task_stage` action `claim`)
- `in_progress` -> `completed` (via `task_stage(action: "complete")`)
- `in_progress` -> `failed` (via `task_stage(action: "fail")`)
- Any non-terminal -> `cancelled` (via `task_stage(action: "cancel")`)

### Dependencies

Dependencies enforce ordering between tasks. A task with an open `blocks` dependency cannot be advanced or completed until the blocking task is closed (completed, failed or cancelled). Claiming does not check dependencies.

Relationship types:

| Type        | Behavior                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `blocks`    | Blocks advance and complete until the dependency is closed; listed under `blockers` / `blocking` |
| `related`   | Informational link, does not block; listed under `links`                                         |
| `duplicate` | Marks tasks as duplicates, does not block; listed under `links`                                  |

One link per task pair: to turn a `related` link into `blocks`, remove it first.

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

### REST API Won't Start

**Symptom:** Port 3422 already in use by another program.

**Solutions:**

1. Set `AGENT_TASKS_PORT` to a free port in the MCP config env and in the environment Claude Code runs in (the `/pipeline` pane reads the same variable).
2. Find and stop the process using port 3422.
3. Multiple agent-tasks MCP instances share the same database. Only the first one serves the REST API; the others retry every 5 s and take over when it exits.

### Task Cannot Be Advanced

**Symptom:** `task_stage(action: "advance")` returns an error.

**Common causes:**

- **Unmet dependencies**: A blocking task is not yet completed. `task_get` always returns `dependencies` and `claim_status` (what blocks it); add `include: ["transitive_deps"]` for the whole chain. Remove a dependency with `task_update`'s `dependency` field.
- **Stage gate requirements**: Required artifacts or comments are missing. The error message lists unmet requirements.
- **Task closed**: a `completed`, `failed` or `cancelled` task cannot be advanced.

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

---

## 9. FAQ

### Can I use this with Cursor/OpenCode?

Yes. agent-tasks is a standard MCP server. Any MCP-compatible client can use it.

### How does it integrate with agent-comm?

agent-tasks optionally connects to agent-comm via `AGENT_COMM_URL`. This enables:

- **Heartbeat-based cleanup**: Detects when agents die and auto-fails their tasks.
- **Bridge notifications**: Notifies connected agents on task events.

Without agent-comm, these features are gracefully skipped.

### What is the TodoWrite bridge?

When configured via hooks, agent-tasks intercepts Claude Code's built-in `TodoWrite` tool calls and syncs them to the pipeline. Todos become tasks on the `/pipeline` board.

### Can multiple agents work on the same task?

Not formally — the dedicated `task_collaborator` tool was removed in the consolidation. Today you have two options:

- **Sequential handoff**: agent A does its piece, calls `task_stage` to advance, agent B claims it (`task_stage` action `claim` with a different `claimer` name).
- **Parent + subtasks**: split the task into N subtasks via `task_create` with `parent_id`, and assign each subtask to a different agent. The pipeline view shows the parent and its children together.

If you genuinely need multi-agent collaborator semantics, the schema still has `task_collaborators`; it just isn't exposed via MCP. File an issue if you want it back.

### How do I reset the pipeline?

Delete and recreate the pipeline stages for a project:

```
task_config with action "pipeline", project "my-project", stages ["backlog", "spec", "plan", "implement", "test", "review", "done"]
```

### What happens to subtasks when a parent is completed?

Subtasks have independent lifecycles. Completing a parent does not auto-complete subtasks. The `/pipeline` board shows `done/total subtasks` on the parent's row, and its detail lists each subtask.

### How do I find the next available task?

```
task_list with next true
```

This returns the single highest-priority unassigned task with all dependencies met. Add `agent: "my-name"` for affinity-based routing.

### Where is the database stored?

Default: `~/.agent-tasks/agent-tasks.db`. Override with `AGENT_TASKS_DB` environment variable. The database uses WAL mode and FK constraints with cascading deletes.
