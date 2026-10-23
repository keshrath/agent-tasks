# Contributing to agent-tasks

Contributions are welcome! This guide covers everything you need to get started.

## Table of Contents

- [Development Setup](#development-setup)
- [Running Tests](#running-tests)
- [Code Style](#code-style)
- [Architecture Overview](#architecture-overview)
- [The /pipeline pane](#the-pipeline-pane)
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
npm run start:server  # Start the REST API at http://localhost:3422
npm run plugin:check  # claude plugin validate + test (needs the claude CLI)
```

In a typical development session, run `npm run dev` in one terminal to watch TypeScript changes, and `npm run start:server` in another to serve the REST API the `/pipeline` pane reads.

---

## Running Tests

The test suite uses [Vitest](https://vitest.dev/) with in-memory SQLite databases. Each test gets a fresh context via `createTestContext()` from `tests/helpers.ts`.

```bash
npm test              # Run all tests (432 across 21 files)
npm run test:watch    # Watch mode — reruns on file changes
npm run test:coverage # Coverage report (v8 provider)
npm run plugin:check  # the /pipeline mod: claude plugin validate + test
npm run e2e:claude    # the /pipeline pane in the real Claude Code CLI, with screenshots
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
  helpers.ts                 Shared test utilities (createTestContext, etc.)
  tasks.test.ts              Core task CRUD, pipeline stages, dependencies, artifacts
  subtasks.test.ts           Parent/child trees and subtask progress
  comments.test.ts           Threaded comments
  collaborators.test.ts      Collaborator service (library only)
  approvals.test.ts          Approval service (library only)
  confidence.test.ts         Claim-time confidence scoring
  stage-instructions.test.ts Per-stage instructions on claim/advance
  cleanup.test.ts            Cleanup/retention logic
  knowledge-bridge.test.ts   Pushing learnings/decisions to agent-knowledge
  rules.test.ts              IDE rule generation
  mcp.test.ts                The 8 MCP tools
  rest.test.ts               REST API endpoints and the request guard
  rest-leader.test.ts        REST leader election (retry, take over)
  search.test.ts             Full-text search
  events.test.ts             Event bus
  validate.test.ts           Input validation
  manifest.test.ts           package.json, server.json and plugin manifest versions
  hooks/hooks.test.ts        The command hook scripts
  e2e/                       Domain workflows end to end (vitest)
  e2e-claude/                The /pipeline pane in the real Claude Code CLI (npm run e2e:claude)
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
  server.ts           REST server (standalone or auto-started by the MCP entry point)
  lib.ts              Library exports (agent-tasks/lib)
  package-meta.ts     name + version from package.json
  types.ts            Shared types and error classes
  domain/
    tasks.ts          Pipeline logic, CRUD, search, subtasks, dependencies
    task-validator.ts Task input validation (pure)
    confidence.ts     Claim-time confidence score
    comments.ts       Threaded comments
    collaborators.ts  Collaborator roles (library only, no tool)
    approvals.ts      Approvals (library only, no tool)
    cleanup.ts        Retention purge and stale-agent cleanup
    agent-bridge.ts   Agent-comm notification bridge
    knowledge-bridge.ts Pushes learnings/decisions to agent-knowledge
    rules.ts          IDE rule generation (.mdc, CLAUDE.md)
    events.ts         In-process event bus
    validate.ts       Input validation constants
  storage/
    database.ts       SQLite (WAL mode, schema versioning, FK cascades, FTS5)
  transport/
    mcp.ts            8 MCP tool definitions + dispatch (handlers: mcp-handlers.ts)
    rest.ts           8 REST endpoints (JSON only)
plugin/               Claude Code plugin: .mcp.json + the /pipeline mod (hooks/, types/, tests/)
```

### Layers

1. **Domain** (`src/domain/`) — all business logic. Services are pure functions that receive a database handle and event bus.
2. **Storage** (`src/storage/`) — SQLite via better-sqlite3. WAL mode, FTS5, schema versioning with idempotent migrations.
3. **Transport** (`src/transport/`) — two parallel transports:
   - **MCP** (stdio JSON-RPC) — for AI agents
   - **REST** (node:http) — for the `/pipeline` pane, hook scripts and integrations
4. **Plugin** (`plugin/`) — the Claude Code mod. Host-specific glue lives here, never in `src/`.

### Data flow

```
MCP tool call / REST request
  -> Transport layer (parse, validate)
    -> Domain layer (business logic)
      -> Storage layer (SQLite)
    <- Domain returns result
  <- Transport formats response
  -> Event bus emits change (agent-comm and agent-knowledge bridges)
```

---

## The /pipeline pane

The Claude Code pane is a mod in `plugin/` (`hooks/register.tsx` + `view.tsx`, function hooks, Claude Code 2.1.289+). It reads and writes through the REST API only.

- Every function that takes `$` must be a top-level declaration (`claude plugin validate` enforces it).
- Tests live in `plugin/tests/*.test.ts` and run under `claude plugin test plugin`, not vitest: `npm run plugin:check`.
- Type-check with a tsconfig kept outside the folder; never `tsc -p plugin`, which emits `.js` into `plugin/`.
- `plugin/.claude-plugin/types/` is written by Claude Code when it loads the mod and is git-ignored.

### e2e in the real CLI

`npm run e2e:claude` (`tests/e2e-claude/`, gated by `AGENT_TASKS_E2E_CLAUDE=1`) builds, then drives `claude` in a pseudo-terminal (node-pty, rendered by @xterm/headless) against a scratch world: its own SQLite file seeded through the domain, `node dist/server.js` on a free port, and a copy of `plugin/` whose `.mcp.json` runs this checkout on that database. `--setting-sources project,local` and `--strict-mcp-config` keep your installed plugins, hooks and MCP servers out; your `~/.agent-tasks` database and port 3422 are never touched. Every flow is checked on the screen text and on the REST state after it: the board by stage with the blocked marker and the status entry, the tab hotkeys, Done and a failed task's error, a task's detail (stage strip, description, subtasks, an artifact unfolded, a comment sent as `AGENT_TASKS_USER`), `/pipeline <id>` and `/pipeline <text>`, Advance, Send back with a reason, Complete with a result, Fail (and Never mind), Cancel, Delete behind its confirmation, a blocked task that cannot move on, the New form walked with Enter, Find (a project name too), toasts and the status entry after changes from another session, a narrow dock (110 columns), the inline layout, and the server going away with Refresh bringing it back. Where the focus ring lands after each move is asserted too. It needs a logged-in `claude` on PATH; slash commands and the pane make no model calls, so a run costs no tokens and takes about six minutes. Screenshots land in `~/.claude/tmp/pane-shots-tasks/e2e/` (`AGENT_TASKS_E2E_SHOTS` overrides), rendered by Playwright's Chromium (`npx playwright install chromium` once).

For visual work, drive one session by hand and look at each step: `npx tsx tests/e2e-claude/drive.ts [cols] [rows]` (`FULLSCREEN=1` for the docked layout) starts a scratch world and serves `curl -s localhost:47331 -d '{"op":"shot","label":"x"}'` (ops: `pipeline`, `key`, `type`, `press`, `focus`, `wait`, `screen`, `shot`, `ids`, `sync`, `quit`). `sync` copies `plugin/hooks` and `plugin/types` into the session's plugin and runs `/reload-plugins`. Keys sent while the pane does not hold the keyboard go to the prompt and start a model turn, and keys sent while `/pipeline` still runs are queued for the prompt: wait for its answer first.

`npx tsx tests/e2e-claude/tutorial.ts --docs` records the tutorial: a scripted fullscreen session with captions, filmed to `~/.claude/tmp/pane-shots-tasks/tutorial/pipeline-tutorial.webm` (Playwright records a replay, no ffmpeg) with one still per step, copied to `docs/images/tutorial/` for `docs/TUTORIAL.md`; `--render` films the last recording again. Re-record it when the pane changes.

---

## Adding Features

1. Add types to `src/types.ts`
2. Add domain logic in `src/domain/`
3. Add MCP tool definition + dispatch in `src/transport/mcp.ts`
4. Add REST endpoint in `src/transport/rest.ts` if needed
5. Show it in the `/pipeline` pane (`plugin/hooks/`) if a person needs to see or act on it
6. Add tests in `tests/` (and `plugin/tests/` for the pane)
7. Update `CHANGELOG.md` for a feature release

---

## Database Migrations

Schema changes go in `src/storage/database.ts`. Follow this pattern:

1. Append a new `{ version: N, up }` entry to the `migrations` array (agent-common's runner applies them in version order and records the version in `_meta`)
2. Never edit an old migration
3. Migrations **must be idempotent** — use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` with existence checks
4. All tables use foreign keys with `ON DELETE CASCADE`

Current schema version: **V5**

---

## Submitting Pull Requests

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes following the code style guidelines above
4. Ensure all checks pass: `npm run check`
5. Write or update tests for your changes
6. For a feature release, add a `CHANGELOG.md` entry (patch releases get none)
7. Submit a pull request with a clear description

### PR checklist

- [ ] `npm run check` passes (typecheck + lint + format + test)
- [ ] New features have tests
- [ ] `CHANGELOG.md` entry, if this is a feature release
- [ ] No `any` types introduced
- [ ] No inline comments (use section headers)

---

## Commit Messages

Format: `vX.Y.Z: short description`

Keep messages concise and descriptive. No Co-Authored-By or AI branding.
