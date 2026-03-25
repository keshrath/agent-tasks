# Contributing to agent-tasks

## Development Setup

```bash
git clone https://github.com/keshrath/agent-tasks.git
cd agent-tasks
npm install
npm run build
```

## Running Tests

```bash
npm test              # Run all tests (271+)
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

## Quality Checks

All code must pass before committing:

```bash
npm run check  # typecheck + lint + format + test
```

Pre-commit hooks (husky + lint-staged) enforce formatting and linting automatically.

## Code Style

- TypeScript strict mode
- Prettier for formatting (100 char width, single quotes, trailing commas)
- ESLint with TypeScript rules (no `any`, no unused vars, `===` only)
- No inline comments — use file-level section headers only
- Custom error hierarchy: `TasksError`, `NotFoundError`, `ConflictError`, `ValidationError`

## Architecture

```
src/
  context.ts          DI root (no global state)
  domain/             Business logic (services receive Db + EventBus)
  storage/            SQLite with schema versioning
  transport/          MCP (stdio), REST (node:http), WebSocket (ws)
  ui/                 Vanilla JS dashboard (no build step)
```

## Adding Features

1. Add types to `src/types.ts`
2. Add domain logic in `src/domain/`
3. Add MCP tool definition + dispatch in `src/transport/mcp.ts`
4. Add REST endpoint in `src/transport/rest.ts` if needed
5. Add tests in `tests/`
6. Update `CHANGELOG.md`

## Database Migrations

Schema changes go in `src/storage/database.ts`. Add a new `migrateVN()` function and increment `SCHEMA_VERSION`. Migrations must be idempotent (`CREATE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` with existence checks).

## Commit Messages

Format: `v1.x.y: short description`

No Co-Authored-By or Claude branding.
