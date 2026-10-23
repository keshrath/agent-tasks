# agent-tasks

## Architecture

Layered architecture with explicit dependency injection (no global state):

```
src/
  index.ts    MCP stdio entry point; one process serves the REST API (leader election on the port; the others retry and take over)
  server.ts   REST server (standalone: node dist/server.js [--port] [--db])
  domain/     tasks (stages, dependencies, artifacts, claiming), events, validation
  storage/    SQLite (better-sqlite3, WAL mode)
  transport/  REST (node:http, JSON only), MCP (stdio)
plugin/       Claude Code plugin (.mcp.json + one mod: hooks/register.tsx + view.tsx = /pipeline pane)
```

- **No frameworks** — no React, Vue, Express. Pure Node.js + TypeScript.
- `context.ts` is the DI root — wires all services together.
- `src/` stays host-agnostic; Claude-specific glue belongs in `plugin/` (the mod) or `scripts/hooks/` (command hooks wired by `scripts/setup.js`).
- **Soft deps**: `AgentBridge` → agent-comm (notifications), `KnowledgeBridge` → agent-knowledge (push learnings/decisions on task completion). Both HTTP-only, fail-open.

## UI surfaces

There is no web dashboard (removed in 2.0, with the WebSocket, the UI files and the agent-desk plugin).

- **Claude Code pane** (`plugin/hooks/register.tsx` + `view.tsx`, Claude Code 2.1.289+ function hooks): `/pipeline` opens it (the built-in `/tasks` is taken); `/pipeline 12` opens task 12, `/pipeline <text>` filters the board. Tabs Board (open tasks by stage, Find over id, title, agent, project and tags, `waits for #N` on blocked rows), Done (recently closed, who and where, the result beneath), New (title, project, priority, tags, description; Enter walks the fields). Task detail: stage strip, actions for a task in progress (Advance › next, Complete, ‹ Send back with a stage, Fail; Cancel, Delete with a confirmation), facts, description, subtasks, artifacts (unfold as Markdown), comments + a comment field. No Claim: agents claim with `task_stage`, and an assignee that is no live agent-comm agent gets reaped by the cleanup; an unclaimed task has no Advance either (it would sit in progress with nobody on it). A blocked task shows no Advance or Complete (the domain refuses both while a `blocks` dependency is open), only what it waits for. Status line entry and the board's summary are the same text (`headline()` in view.tsx); toasts only for tasks that finished or reached review since the last poll; one `prompt.context` block with what is in flight. Acts as `AGENT_TASKS_USER`, else the OS user (`created_by`, comment author, `by`). Polls `GET /api/board` every 5 s while open, 30 s while closed. REST only, through `$.http.fetch` on `AGENT_TASKS_PORT` (default 3422). View state in `$.state` (contract `plugin/types/index.d.ts`). Opened as a plain sidebar (no `closeOnEscape`); `/pipeline` reports `isPlaced: false` with the reason. Focus lands explicitly after every navigation and action, a fold's toggle included (`landing()`, `toggle()` in register.tsx): the engine keeps the ring at its place in the focus order across a redraw, not on a key, so a redraw that adds or drops a control above it would move it; a key that names the new state (`foldKey`, `advance:<stage>`, the fresh `comment:<rev>`) makes the focus wait for the drawing that shows it. The element `landing()` names is also drawn `autoFocus`, and `/pipeline` closes and reopens an open pane after setting the view, because a take would otherwise put the ring back on the element it last held. Every function that takes `$` must be a top-level declaration (`claude plugin validate` enforces it). Tests: `plugin/tests/*.test.ts` under `claude plugin test plugin` (`npm run plugin:check`); vitest excludes `plugin/`. Type-check with a tsconfig outside the folder (never `tsc -p plugin`, it emits .js into plugin/).
- **MCP tool results** (JSON + the pipeline footer) for every other host.

## Code Style

- No inline comments — only file-level section headers (`// === ... ===` or `// --- ... ---`)
- No Co-Authored-By or Claude branding in commits
- ESLint + Prettier enforced via lint-staged (husky pre-commit)

## Versioning

- Version lives in `package.json` and is read at runtime (REST `/health`, MCP `initialize`)
- Never hardcode version strings
- `package.json`, `server.json` (top-level and package entry) and `plugin/.claude-plugin/plugin.json` stay on the same version (`tests/manifest.test.ts`); `plugin/.mcp.json` pins the major (`agent-tasks@^2`)
- Every commit must bump the patch version minimum; patch bumps get no CHANGELOG entry, feature releases do
- Commit message format: `vX.Y.Z: short description`

## Build & Test

```
npm run build         # tsc
npm test              # vitest (unit + integration)
npm run check         # typecheck + lint + format + test
npm run plugin:check  # claude plugin validate + test (needs the claude CLI)
npm run e2e:claude    # the /pipeline pane in the real Claude Code CLI (tests/e2e-claude/, screenshots; drive.ts to steer one by hand)
npm run dev           # tsc --watch
```

## Pipeline Stages

Default: `backlog → spec → plan → implement → test → review → done`

Configurable per project via `task_config` (`action: "pipeline"`). Tasks advance through stages sequentially; dependencies block advancement until resolved.

## Key APIs

- **REST** (8 routes, only what the pane and the hooks call; loopback, agent-common request guard, and any request carrying an `Origin` is refused): `GET /health`, `POST /api/tasks`, `GET/DELETE /api/tasks/:id` (the `task_get` shape, `?include=subtasks,comments,transitive_deps`), `POST /api/tasks/:id/stage` (the `task_stage` actions, `by` = who acts), `POST /api/tasks/:id/comments`, `GET /api/board` (what the pane polls), `GET /api/pipeline`. Full list: `docs/API.md`
- **MCP** (8 tools): `task_create`, `task_get` (include subtasks/artifacts/comments/transitive_deps), `task_list` (search via `query`, pick next via `next: true`), `task_update` (metadata + dependencies), `task_delete`, `task_stage` (claim/assign/advance/regress/complete/fail/cancel), `task_artifact` (general/decision/learning/comment), `task_config`

## Live Updates

Every MCP process writes the same SQLite DB (WAL). The REST server reads it on each request, so the `/pipeline` pane sees changes from any session on its next poll.

## Domain Model

- **Task**: id, title, description, status (pending/in_progress/completed/failed/cancelled), stage, priority, project, assigned_to, parent_id, tags, result, created_by, created_at, updated_at
- **Status transitions**: pending -> in_progress (claim), in_progress -> completed/failed, any non-terminal -> cancelled
- **Stage transitions**: Sequential through pipeline; regress allowed to any earlier stage; dependencies block advancement
- **Artifact**: name + stage + task_id = identity; version auto-incremented, previous_id links history
- **Comment**: threaded via parent_comment_id; agent_id tracks author
- **Collaborator**, **Approval**: tables and library services (`ctx.collaborators`, `ctx.approvals`) that no MCP tool or REST route writes; a `require_approval` gate therefore cannot be passed through the tools
- **Dependency**: task_id -> depends_on_id + relationship (`blocks` forms a DAG with cycle detection and is the only kind that blocks or shows as blockers/blocking; `related`, `duplicate` show as `links` with a direction; one row per task pair)

## Error Handling

Custom error hierarchy in `src/types.ts`:

- `TasksError` (base, 400) -> `NotFoundError` (404), `ConflictError` (409), `ValidationError` (422)
- Always use these instead of plain `Error` — the MCP transport formats them for tool responses

## Testing

- Framework: vitest with global test functions
- Test files: `tests/*.test.ts`, the command hooks in `tests/hooks/`, end-to-end MCP flows in `tests/e2e/` (all vitest); the pane's tests in `plugin/tests/` (claude plugin test); the pane in the real CLI in `tests/e2e-claude/` (vitest, skipped unless `AGENT_TASKS_E2E_CLAUDE=1`)
- In-memory SQLite via `createTestContext()` from `tests/helpers.ts`
- Each test gets a fresh context in `beforeEach`, closed in `afterEach`
- Pattern: Arrange-Act-Assert with descriptive `describe`/`it` blocks

## Database

- SQLite with WAL mode, better-sqlite3
- Schema versioning via `_meta` table (current: V5)
- Migrations: the version-ordered `migrations` array in `src/storage/database.ts` (agent-common runner); add a new entry, never edit an old one
- All tables use FK constraints with `ON DELETE CASCADE`
- FTS5 virtual table for full-text search with triggers for sync
