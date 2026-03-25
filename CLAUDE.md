# agent-tasks

## Architecture

Layered architecture with explicit dependency injection (no global state):

```
src/
  domain/     tasks (stages, dependencies, artifacts, claiming), events, validation
  storage/    SQLite (better-sqlite3, WAL mode)
  transport/  REST (node:http), WebSocket (ws), MCP (stdio)
  ui/         Vanilla JS kanban dashboard (no build step for UI)
```

- **No frameworks** — no React, Vue, Express. Pure Node.js + TypeScript.
- `context.ts` is the DI root — wires all services together.
- UI files (`index.html`, `app.js`, `styles.css`) are plain files copied to `dist/ui/` on build.

## UI / Dashboard

- **Layout**: Kanban board with columns per pipeline stage
- **Icons**: Material Symbols Outlined (via Google Fonts CSS). No emojis.
- **Fonts**: Inter (UI text), JetBrains Mono (code/data)
- **Theme**: Light/dark toggle via `data-theme="dark"` attribute on `<html>`
- **Design tokens**: CSS custom properties (`--bg`, `--accent`, `--border`, `--shadow-*`, etc.)
- **Accent color**: `#5d8da8`
- **Radii**: 8px cards/columns, 4px tags
- **Column headers**: Uppercase, 12px, weight 600, letter-spacing 0.5px
- **Tags**: Color-coded by type (project=accent, assignee=purple, priority=orange, artifacts=blue, blocked=red)

## Code Style

- No inline comments — only file-level section headers (`// === ... ===` or `// --- ... ---`)
- No Co-Authored-By or Claude branding in commits
- ESLint + Prettier enforced via lint-staged (husky pre-commit)

## Versioning

- Version lives in `package.json` and is read at runtime (REST `/health`, WS state payload, UI header)
- Never hardcode version strings
- Every commit must bump the patch version minimum
- Commit message format: `v1.0.x: short description`

## Build & Test

```
npm run build      # tsc + copy UI files to dist/
npm test           # vitest (unit + integration)
npm run check      # typecheck + lint + format + test
npm run dev        # watch mode (tsc + nodemon)
```

## Pipeline Stages

Default: `backlog → spec → plan → implement → test → review → done`

Configurable per project via `task_pipeline_config`. Tasks advance through stages sequentially; dependencies block advancement until resolved.

## Key APIs

- **REST**: `GET /health`, `GET/POST /api/tasks`, `PUT /api/tasks/:id/stage`, `GET /api/tasks/:id/artifacts`, `GET/POST /api/tasks/:id/comments`, `GET /api/search?q=`, `GET /api/agents`
- **WebSocket**: Full state on connect, incremental events streamed, DB polling for cross-process updates (2s interval)
- **MCP** (33 tools): `task_create`, `task_list`, `task_claim`, `task_advance`, `task_complete`, `task_add_artifact`, `task_comment`, `task_search`, `task_add_collaborator`, `task_request_approval`, `task_approve`, `task_reject`, `task_review_cycle`, `task_generate_rules`, etc.

## Live Updates

The dashboard server polls the SQLite DB every 2 seconds to detect changes made by other processes (MCP stdio servers). This ensures the kanban board stays in sync even when tasks are created/modified via MCP tools in separate Claude Code sessions.

## Domain Model

- **Task**: id, title, description, status (pending/in_progress/completed/failed/cancelled), stage, priority, project, assigned_to, parent_id, tags, result, created_by, created_at, updated_at
- **Status transitions**: pending -> in_progress (claim), in_progress -> completed/failed, any non-terminal -> cancelled
- **Stage transitions**: Sequential through pipeline; regress allowed to any earlier stage; dependencies block advancement
- **Artifact**: name + stage + task_id = identity; version auto-incremented, previous_id links history
- **Comment**: threaded via parent_comment_id; agent_id tracks author
- **Collaborator**: task_id + agent_id + role (collaborator/reviewer/watcher)
- **Approval**: task_id + stage + status (pending/approved/rejected); blocks advancement when required
- **Dependency**: task_id -> depends_on_id (DAG with cycle detection)

## Error Handling

Custom error hierarchy in `src/types.ts`:

- `TasksError` (base, 400) -> `NotFoundError` (404), `ConflictError` (409), `ValidationError` (422)
- Always use these instead of plain `Error` — the MCP transport formats them for tool responses

## Testing

- Framework: vitest with global test functions
- Test files: `tests/*.test.ts` (7 files, 109 tests)
- In-memory SQLite via `createTestContext()` from `tests/helpers.ts`
- Each test gets a fresh context in `beforeEach`, closed in `afterEach`
- Pattern: Arrange-Act-Assert with descriptive `describe`/`it` blocks

## Database

- SQLite with WAL mode, better-sqlite3
- Schema versioning via `_meta` table (current: V2)
- Migrations in `src/storage/database.ts`: `migrateV1()`, `migrateV2()`
- All tables use FK constraints with `ON DELETE CASCADE`
- FTS5 virtual table for full-text search with triggers for sync
