# API Reference

agent-tasks exposes two transport layers: MCP (stdio) and a loopback REST API (HTTP), which the Claude Code `/pipeline` pane and the hook scripts read.

## MCP Tools (8)

agent-tasks consolidates everything into 8 action-based tools to keep per-prompt overhead minimal.

**Results and errors.** A tool result is the JSON of what the tool returns, as text, followed by a short pipeline reminder (`AGENT_TASKS_INSTRUCTIONS=0` drops it). A failure is a result with `isError: true` and the text `Error [CODE]: message`, where `CODE` is `NOT_FOUND` (no such task, comment or artifact), `CONFLICT` (the task's state does not allow it: closed, blocked by a dependency, already at its last stage), `VALIDATION_ERROR` (bad input, or a stage gate not met) or `UNKNOWN_ERROR` (anything unexpected).

### Task CRUD

| Tool          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_create` | Create a pipeline task (title, description, priority, project, tags, parent_id, assign_to, stage)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `task_get`    | Get a task with optional `include: ["subtasks", "artifacts", "comments", "transitive_deps"]` (comments: the newest `limit`, default 100, oldest first). `dependencies.blockers` / `blocking` list `blocks` links only; `dependencies.links` lists `related` / `duplicate` links as `{ task, relationship, direction }`. `gate_needs`: what the stage gate still needs before the task may leave its stage (`{ stage, comment, artifact, artifacts, min_artifacts, approval }`), `null` when nothing or when closed. |
| `task_list`   | List/search tasks (filters: query, status, stage, project, assign_to, collaborator, root_only, parent_id, tags, pagination)                                                                                                                                                                                                                                                                                                                                                                                         |
| `task_update` | Update metadata (title, description, priority, project, tags, assign_to). Inline `dependency: { action, depends_on, relationship }` for add/remove.                                                                                                                                                                                                                                                                                                                                                                 |
| `task_delete` | Delete a task with cascading cleanup of subtasks, comments, artifacts                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Lifecycle

| Tool         | Description                                                                                                                                                                                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_stage` | All lifecycle transitions via `action`: `claim` (assign to caller, advance from backlog), `assign` (assign to caller, stage unchanged — for pipelines whose first stage is itself a do-work stage), `advance` (next stage or specific via `stage`), `regress`, `complete`, `fail`, `cancel`. Optional `comment` and `result`/`reason`. |

### Artifacts

| Tool            | Description                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_artifact` | All artifact operations: attach a `general` document, record a `decision` (chose/over/because), capture a `learning` (auto-propagated to siblings on completion), or post a threaded `comment`. |

### Configuration & utilities

| Tool          | Description                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_config` | Configuration via `action`: `pipeline` (get/set stages and gates), `session` (set agent identity), `cleanup` (retention/stale agents), `rules` (generate IDE rules) |

### Stage gates: confidence threshold and per-stage instructions

`GateConfig` (set per-project via `task_config(action: "pipeline", project, gate_config)`) supports two extra fields beyond the existing `require_comment` / `require_artifact` / `gates`:

- **`min_confidence_for_claim`** (number, 0–100, optional) — Before a `task_stage(action: "claim")` succeeds, the task's title and description are scored by a deterministic heuristic (`scoreTaskConfidence`). If the score is below this threshold, the claim is rejected with a `ValidationError` listing what is missing (e.g. _"Title has only 1 word"_, _"No file path referenced"_, _"No acceptance language"_). No LLM calls — purely structural checks. Omit/null/0 to disable. Backward-compatible: existing projects without a gate are unaffected.
- **`stage_instructions`** (`Record<stage, string>`, optional) — Per-stage prompt text surfaced to agents on `task_stage(action: "claim" | "advance")`. When set, the JSON returned by those calls includes a `stage_instructions` field with the string for the new stage. Lets a project author one-time guidance ("at 'spec' stage, write the acceptance criteria as a checklist") without each agent re-deriving it from CLAUDE.md.

Example `gate_config`:

```json
{
  "min_confidence_for_claim": 50,
  "stage_instructions": {
    "spec": "Write the acceptance criteria as a checklist before advancing.",
    "plan": "List the files you intend to touch and any new dependencies.",
    "test": "Run npm test and attach the output as an artifact."
  }
}
```

---

## REST API (8 endpoints)

All endpoints return JSON. Loopback only: a foreign `Host` header gets 403, request bodies must be `application/json`, no wildcard CORS. Any request that carries an `Origin` header gets 403 too: the callers (the `/pipeline` pane, the hook scripts) are not browsers, so no web page on the machine can reach the API. The server runs on port 3422 by default. The routes are what the pane and the hook scripts call; everything else goes through the MCP tools.

### Read endpoints

| Method | Path             | Description                                                                                                                                                                                                                             |
| ------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`        | Health check with version, uptime, and task count                                                                                                                                                                                       |
| `GET`  | `/api/tasks/:id` | A single task in the `task_get` shape: dependencies (`blockers`, `blocking`, `links`), claim status, `gate_needs`, every artifact, `comments_count` (query: `include=subtasks,comments,transitive_deps`; `comments` are the newest 100) |
| `GET`  | `/api/pipeline`  | Pipeline stages and gate config (query: `project`)                                                                                                                                                                                      |
| `GET`  | `/api/board`     | Every open task, the most recently closed ones (`?recent=30`), per-project pipelines, dependencies, subtask progress (what the pane polls)                                                                                              |

### Write endpoints

| Method   | Path                      | Description                                                                                                                                                                                                                                         |
| -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/tasks`              | Create a task (body: `title`, `description?`, `priority?`, `project?`, `tags?`, `parent_id?`, `assign_to?`, `stage?`, `created_by?`, default `api`)                                                                                                 |
| `POST`   | `/api/tasks/:id/stage`    | Lifecycle action, as the MCP `task_stage` (body: `action`, `stage?`, `comment?`, `reason?`, `result?`, `claimer?`, `by?`). `by` names who acts (default `api`): the claimer when none is given, the author of an advance comment and of a rejection |
| `POST`   | `/api/tasks/:id/comments` | Add a comment (body: `content`, `agent_id?` (the author, default `api`), `parent_comment_id?`)                                                                                                                                                      |
| `DELETE` | `/api/tasks/:id`          | Delete a task                                                                                                                                                                                                                                       |

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
| 403    | Foreign `Host` header, or any `Origin`      |
| 404    | Entity not found                            |
| 409    | Conflict (e.g. dependency cycle)            |
| 415    | Request body is not `application/json`      |
| 422    | Input validation failure                    |
| 500    | Internal server error                       |
