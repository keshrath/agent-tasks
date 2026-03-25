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

Configurable per project via `hub_configure_pipeline`. Tasks advance through stages sequentially; dependencies block advancement until resolved.

## Key APIs

- **REST**: `GET /health`, `GET /api/tasks`, `POST /api/tasks`, `GET /api/tasks/:id/artifacts`, etc.
- **WebSocket**: Full state on connect (tasks, dependencies, artifact counts, stages), incremental events streamed
- **MCP**: `hub_create_task`, `hub_claim_task`, `hub_advance_task`, `hub_add_artifact`, `hub_list_tasks`, etc.
