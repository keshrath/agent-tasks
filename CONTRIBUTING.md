# Contributing to agent-tasks

Contributions are welcome! This guide covers everything you need to get started.

## Table of Contents

- [Development Setup](#development-setup)
- [Running Tests](#running-tests)
- [Code Style](#code-style)
- [Architecture Overview](#architecture-overview)
- [UI Development](#ui-development)
- [Adding Features](#adding-features)
- [Database Migrations](#database-migrations)
- [Submitting Pull Requests](#submitting-pull-requests)
- [Commit Messages](#commit-messages)

---

## Development Setup

### Prerequisites

- **Node.js** >= 20.11 (for native ES module support and `node:` imports)
- **npm** >= 10
- **Git**

### Clone and install

```bash
git clone https://github.com/keshrath/agent-tasks.git
cd agent-tasks
npm install
npm run build
```

### Development workflow

```bash
npm run dev           # TypeScript watch mode (recompiles on save)
npm run start:server  # Start the dashboard at http://localhost:3422
```

In a typical development session, run `npm run dev` in one terminal to watch TypeScript changes, and `npm run start:server` in another to preview the dashboard.

---

## Running Tests

The test suite uses [Vitest](https://vitest.dev/) with in-memory SQLite databases. Each test gets a fresh context via `createTestContext()` from `tests/helpers.ts`.

```bash
npm test              # Run all tests (355 across 13 files)
npm run test:watch    # Watch mode — reruns on file changes
npm run test:coverage # Coverage report (v8 provider)
```

### Full quality check

All code must pass the full check pipeline before merging:

```bash
npm run check         # typecheck + lint + format:check + test
```

This is what CI runs. Pre-commit hooks (husky + lint-staged) also enforce formatting and linting automatically on staged files.

### Test structure

```
tests/
  helpers.ts           Shared test utilities (createTestContext, etc.)
  tasks.test.ts        Core task CRUD, pipeline stages, dependencies
  comments.test.ts     Threaded comments
  collaborators.test.ts  Multi-agent collaboration
  approvals.test.ts    Stage-gated approval workflows
  artifacts.test.ts    Artifact versioning
  cleanup.test.ts      Cleanup/retention logic
  rules.test.ts        IDE rule generation
  rest.test.ts         REST API endpoint tests
  search.test.ts       Full-text search
  events.test.ts       Event bus
  validate.test.ts     Input validation
```

Each test file follows the Arrange-Act-Assert pattern with descriptive `describe`/`it` blocks.

---

## Code Style

### TypeScript

- **Strict mode** enabled (`strict: true` in tsconfig)
- **No `any`** — ESLint rule enforced
- **No unused variables** — ESLint rule enforced
- **`===` only** — no loose equality

### Formatting

- **Prettier** — 100 character line width, single quotes, trailing commas
- **ESLint** with TypeScript rules

Both are enforced via lint-staged on commit. To run manually:

```bash
npm run format        # Auto-format all files
npm run format:check  # Check formatting without changing files
npm run lint          # Run ESLint
npm run lint:fix      # Auto-fix ESLint issues
```

### Conventions

- **No inline comments** — use file-level section headers only (`// === Section ===` or `// --- Section ---`)
- **Custom error hierarchy**: `TasksError` (base, 400) > `NotFoundError` (404) > `ConflictError` (409) > `ValidationError` (422). Always use these instead of plain `Error`.
- **No frameworks** — no React, Vue, Express. Pure Node.js + TypeScript.
- **Dependency injection** — services receive `Db` and `EventBus` via `context.ts`, no global state.

---

## Architecture Overview

```
src/
  context.ts          DI root — wires all services (no global state)
  index.ts            MCP entry point (stdio JSON-RPC)
  server.ts           HTTP + WebSocket standalone server
  types.ts            Shared types and error classes
  domain/
    tasks.ts          Pipeline logic, CRUD, search, subtasks, dependencies
    comments.ts       Threaded comments
    collaborators.ts  Multi-agent collaboration with roles
    approvals.ts      Stage-gated approval workflows
    agent-bridge.ts   Agent-comm notification bridge
    rules.ts          IDE rule generation (.mdc, CLAUDE.md)
    events.ts         In-process event bus
    validate.ts       Input validation constants
  storage/
    database.ts       SQLite (WAL mode, schema versioning, FK cascades, FTS5)
  transport/
    mcp.ts            31 MCP tool definitions + dispatch
    rest.ts           19 REST endpoints + static file serving
    ws.ts             WebSocket event streaming + livereload
  ui/
    index.html        Dashboard HTML
    app.js            Kanban client (vanilla JS)
    styles.css        Light/dark theme, responsive
```

### Layers

1. **Domain** (`src/domain/`) — all business logic. Services are pure functions that receive a database handle and event bus.
2. **Storage** (`src/storage/`) — SQLite via better-sqlite3. WAL mode, FTS5, schema versioning with idempotent migrations.
3. **Transport** (`src/transport/`) — three parallel transports:
   - **MCP** (stdio JSON-RPC) — for AI agents
   - **REST** (node:http) — for scripts and integrations
   - **WebSocket** (ws) — for real-time dashboard updates
4. **UI** (`src/ui/`) — vanilla HTML/JS/CSS. No build step for UI files (they're copied to `dist/ui/` on build).

### Data flow

```
MCP tool call / REST request
  -> Transport layer (parse, validate)
    -> Domain layer (business logic)
      -> Storage layer (SQLite)
    <- Domain returns result
  <- Transport formats response
  -> Event bus emits change
    -> WebSocket broadcasts to dashboard
```

---

## UI Development

The dashboard is built with **vanilla HTML, CSS, and JavaScript** — no build step, no framework.

### Files

| File                | Description                                                         |
| ------------------- | ------------------------------------------------------------------- |
| `src/ui/index.html` | Dashboard HTML structure, modals, CDN imports                       |
| `src/ui/app.js`     | All client-side logic: WebSocket, rendering, drag-and-drop, filters |
| `src/ui/styles.css` | Complete styling with light/dark theme via CSS custom properties    |

### How to develop

1. Edit files in `src/ui/`
2. Run `npm run build` (copies UI files to `dist/ui/`)
3. Run `npm run start:server` to preview
4. The dashboard supports **livereload** — WebSocket sends a `reload` event when files change in dev mode

### Design system

- **Icons**: Material Symbols Outlined (loaded via Google Fonts CDN)
- **Fonts**: Inter (UI text), JetBrains Mono (code/monospace)
- **Accent color**: `#5d8da8`
- **Theme**: `data-theme="dark"` attribute on `<html>` toggles dark mode
- **Design tokens**: CSS custom properties (`--bg`, `--accent`, `--border`, `--shadow-*`, etc.)
- **Card radii**: 8px for cards and columns, 4px for tags
- **Rendering**: [morphdom](https://github.com/patrick-steele-idem/morphdom) for efficient DOM diffing, [marked](https://github.com/markedjs/marked) + [DOMPurify](https://github.com/cure53/DOMPurify) for Markdown, [highlight.js](https://highlightjs.org/) for syntax highlighting

---

## Adding Features

1. Add types to `src/types.ts`
2. Add domain logic in `src/domain/`
3. Add MCP tool definition + dispatch in `src/transport/mcp.ts`
4. Add REST endpoint in `src/transport/rest.ts` if needed
5. Add WebSocket event emission if the UI needs to react
6. Add tests in `tests/`
7. Update `CHANGELOG.md`

---

## Database Migrations

Schema changes go in `src/storage/database.ts`. Follow this pattern:

1. Add a new `migrateVN()` function
2. Increment `SCHEMA_VERSION`
3. Migrations **must be idempotent** — use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` with existence checks
4. All tables use foreign keys with `ON DELETE CASCADE`

Current schema version: **V3**

---

## Submitting Pull Requests

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes following the code style guidelines above
4. Ensure all checks pass: `npm run check`
5. Write or update tests for your changes
6. Update `CHANGELOG.md` with your changes
7. Submit a pull request with a clear description

### PR checklist

- [ ] `npm run check` passes (typecheck + lint + format + test)
- [ ] New features have tests
- [ ] `CHANGELOG.md` updated
- [ ] No `any` types introduced
- [ ] No inline comments (use section headers)

---

## Commit Messages

Format: `v1.x.y: short description`

Keep messages concise and descriptive. No Co-Authored-By or AI branding.
