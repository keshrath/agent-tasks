# agent-tasks

## Architecture

- **Backend**: Node.js + TypeScript, native `node:http`, SQLite (better-sqlite3), WebSocket (ws)
- **Frontend**: Vanilla JS kanban dashboard, Material Symbols icons, custom CSS with design tokens
- **No frameworks** — no React, Vue, or Express

## Design

- **Accent**: `#5d8da8`
- **Fonts**: Inter (sans), JetBrains Mono (mono)
- **Radii**: 8px (cards/columns), 4px (tags)
- **Shadows**: 3-level token system (`--shadow-1/2/3`)
- **Theme**: Light/dark via `data-theme` attribute
- **Density**: Compact (developer tool)
- **Column headers**: Uppercase, 12px, font-weight 600, letter-spacing 0.5px

## Rules

- Version is read from `package.json` at runtime (REST + WS), never hardcoded
- Every commit bumps the patch version minimum
- Commit message prefix: `v1.0.x: short description`
- No Co-Authored-By or Claude branding in commits
- No comments in code except file-level section headers

## Build

```
npm run build    # tsc && copy-ui
npm run check    # typecheck + lint + format + test
```
