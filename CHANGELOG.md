# Changelog

All notable changes to agent-tasks are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [1.2.1] - 2026-03-25

### Added

- **Schema V3** — dependency relationship types (blocks/related/duplicate)
- **`task_expand` tool** — break a task into subtasks inheriting project and priority
- **`task_cleanup` tool** — manual data cleanup for completed/cancelled tasks
- **`count()` method** — efficient task counting without loading all rows
- **Cleanup tests** — `tests/cleanup.test.ts` for CleanupService and retention logic
- **Rules tests** — `tests/rules.test.ts` for IDE rule generation

### Changed

- Rate limiter now periodically cleans up stale entries (prevents unbounded memory growth)
- `MAX_BODY_SIZE` increased to 128KB for larger artifact payloads
- MCP server version now reads from package.json at runtime (was hardcoded 1.0.0)
- `/health` endpoint uses `count()` instead of loading full task list
- `fail()` method wrapped in transaction for consistency with `complete()`/`cancel()`
- Rate limit 429 response now uses shared `SECURITY_HEADERS`
- Updated docs: CLAUDE.md (V3 schema, 271+ tests), README badges, CONTRIBUTING test counts

### Fixed

- Rate limiter memory leak — stale IP entries now cleaned up every 5 minutes

## [1.2.0] - 2026-03-25

### Added

- **TodoWrite bridge hook** — PreToolUse hook intercepts TodoWrite/TaskCreate and syncs to agent-tasks via REST
- **Response-embedded instructions** — behavioral guidance appended to every MCP tool response
- **Session file bridge** — `task_set_session` writes `hub-session.{id}.json` for hook compatibility
- **Auto-assignment** — `advance()` checks `pipeline_config.assignment_config` for auto-assign rules
- **Maker-checker** — `task_review_cycle` convenience tool for approve/reject workflow
- **Agent-comm bridge** — notifies agents via agent-comm REST API on task events (claim, advance, comment, approval)
- **IDE rule generation** — `task_generate_rules` MCP tool for Cursor (.mdc) and Claude Code (CLAUDE.md) formats

### Changed

- `pipeline-enforcer.js` and `todo-enforcer.js` updated to read from `~/.agent-tasks/agent-tasks.db`

## [1.1.0] - 2026-03-25

### Added

- **Schema V2** — comments, collaborators, approvals, subtasks, artifact versioning, FTS5 search
- **Comments** — `task_comment`, `task_get_comments` MCP tools + REST endpoints + threaded UI
- **Collaborators** — `task_add_collaborator`, `task_remove_collaborator` with roles (collaborator/reviewer/watcher)
- **Approvals** — `task_request_approval`, `task_approve`, `task_reject`, `task_pending_approvals`
- **Subtasks** — `parent_id` on tasks, `task_get_subtasks`, progress tracking
- **Full-text search** — FTS5 on title+description, `task_search` MCP tool, `GET /api/search`
- **Artifact versioning** — auto-links previous versions on same name+stage
- **Drag-and-drop** — move tasks between kanban columns via HTML5 Drag API
- **Filter bar** — search, project, assignee, priority dropdowns
- **Rich task cards** — priority color borders, subtask progress bars, comment/artifact counts
- **Task detail modal** — subtasks, versioned artifacts, comment thread with add form
- **Empty board state** with guidance text
- **Keyboard navigation** — `/` for search, Tab/Enter between cards, Escape to close
- **Responsive design** — stacked columns on mobile
- 14 REST endpoints (was 7), 32 MCP tools (was 19), 109 tests (was 62)

## [1.0.0] - 2026-03-25

### Added

- Initial release — extracted from claude-hub as standalone MCP server
- Pipeline stages: backlog → spec → plan → implement → test → review → done
- Dependencies with cycle detection
- Per-stage artifacts
- Multi-agent task claiming
- Per-project pipeline configuration
- SQLite/WAL storage via better-sqlite3
- Kanban dashboard at `:3422` with WebSocket live updates
- Light/dark theme toggle
- Layered architecture: domain/storage/transport with DI context
- Custom error hierarchy: TasksError, NotFoundError, ConflictError, ValidationError
- 62 tests across 2 test files
