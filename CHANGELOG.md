# Changelog

All notable changes to this project will be documented in this file.

## [1.9.27] - 2026-04-08

### Changed

- Tidied `.gitignore` with section headers and added `test-results/` + `playwright-report/`.

## [1.9.26] - 2026-04-08

### Added

- **Playwright E2E dashboard test suite** at `tests/e2e-ui/dashboard.pw.ts`. Boots the standalone HTTP+WS server against a temp SQLite DB on a free port, seeds one task per stage, drives the kanban with chromium, and verifies: page loads with no errors, websocket upgrade, every stage column renders with its seeded card, REST `/api/tasks/:id/stage` advance moves a card to the next column. Runnable via `npm run test:e2e:ui`. Devdep `@playwright/test`. Vitest count unchanged at 355.

## [1.9.25] - 2026-04-08

### Changed

- Adopted `createRateLimiter` from agent-common 1.1.0 in place of the local rate-limiter implementation.

## [1.9.24] - 2026-04-08

### Changed

- `CleanupService` now extends `agent-common`'s `CleanupService` base, with thin `start()` / `stop()` wrappers over the inherited `startTimer` / `stopTimer`.

## [1.9.23] - 2026-04-08

### Changed

- `index.ts` MCP dispatcher delegated to `agent-common`'s `startMcpServer` with a `formatResult` footer hook.

## [1.9.22] - 2026-04-08

### Changed

- `transport/ws.ts` delegated to `agent-common`'s `setupWebSocket` with `onMessage` + `broadcast` hooks.

## [1.9.21] - 2026-04-08

### Changed

- `transport/rest.ts` helpers delegated to `agent-common`'s `json.extraHeaders` + `serveStatic.spaFallback`.

## [1.9.20] - 2026-04-08

### Changed

- `storage/database.ts` delegated to `agent-common`'s `createDb` + `Migration[]` runner.

## [1.9.19] - 2026-04-08

### Changed

- Added `agent-common` as a runtime dependency for events, package metadata, and the dashboard server primitives.

## [1.9.18] - 2026-04-07

### Documentation

- **Major rewrite of `docs/USER-MANUAL.md`, `docs/API.md`, and `docs/SETUP.md`** to reflect the post-consolidation MCP tool surface (8 action-based tools, not 14+). The README and CLAUDE.md were already correct; this brings the deeper docs into alignment.
- Removed standalone sections for tools that no longer exist as separate MCP entries: `task_query`, `task_claim`, `task_advance`, `task_complete`, `task_fail`, `task_dependency`, `task_collaborator`, `task_approval`, `task_get_subtasks`, `task_get_artifacts`, `task_get_comments`, `task_add_dependency`, `task_remove_dependency`, `task_request_approval`, `task_approve`, `task_reject`, `task_pending_approvals`, `task_review_cycle`, `task_next`, `task_search`, `task_expand`, `task_comment`, `task_learn`. Their behavior is now documented as actions on the surviving tools (`task_get` with `include`, `task_stage` actions, `task_artifact` types, `task_update.dependency`).
- Added migration notes ("Replaces the former …") under each consolidated tool so readers landing from old docs / cached search results can find the new form.
- FAQ entry on multi-agent collaboration rewritten — `task_collaborator` was removed, the workflow now uses sequential handoff or parent+subtasks.
- Setup `task_complete` / `task_fail` / `task_advance` / `task_claim` references rewritten to the action-based forms.

### Fixed

- All three version files re-aligned to **1.9.18** (`package.json` was 1.9.17, `server.json` was 1.9.16, `agent-desk-plugin.json` was 1.9.16, plus the inner npm package version inside `server.json` had drifted to 1.9.15).

## [1.9.0] - 2026-03-30

### Removed

- **`task_search`** — merged into `task_list(query: "...")` for full-text search
- **`task_next`** — merged into `task_list(next: true)` with optional `agent` for affinity scoring
- **`task_expand`** — removed (use `task_create` with `parent_id` to create subtasks)
- **Dead code cleanup** — deleted 4 orphaned pre-refactor files (`src/db.ts`, `src/event-bus.ts`, `src/session.ts`, `src/tasks.ts`) totaling ~700 lines
- **Backward-compat aliases** — removed 15 old tool name aliases from handler dispatch

### Changed

- MCP tool count: 16 → 13
- **Improved tool descriptions** — all 13 tools now have detailed descriptions with examples, parameter explanations, and getting-started guidance for better LLM adoption
- **Gate config caching** — `getPipelineStages()`, `getGateConfig()`, `getAllGateConfigs()` now use in-memory cache with 30s TTL, invalidated on writes
- **Type-safe agent bridge** — replaced unsafe `as` casts in `agent-bridge.ts` with runtime type guard functions
- Updated all docs (README, CLAUDE.md, ARCHITECTURE.md)

[1.9.0]: https://github.com/keshrath/agent-tasks/compare/v1.8.0...v1.9.0

## [1.8.0] - 2026-03-29

### Changed

- **Tool consolidation round 2** — reduced MCP tool count from 27 to 16 by merging related tools:
  - `task_advance`, `task_regress`, `task_complete`, `task_fail`, `task_cancel` merged into `task_stage(action: "advance"|"regress"|"complete"|"fail"|"cancel")`
  - `task_get_subtasks`, `task_get_artifacts`, `task_get_comments` merged into `task_query(type: "subtasks"|"artifacts"|"comments")`
  - `task_add_artifact`, `task_decision`, `task_learn` merged into `task_artifact(type: "general"|"decision"|"learning")`
  - `task_pipeline_config`, `task_set_session`, `task_cleanup`, `task_generate_rules` merged into `task_config(action: "pipeline"|"session"|"cleanup"|"rules")`
- Old tool names kept as backward-compatible aliases in the handler dispatch map
- Domain layer unchanged — only MCP transport layer refactored

## [1.8.0] - 2026-03-29

### Changed

- **Tool consolidation** — reduced MCP tool count from 33 to 27 by merging related tools:
  - `task_request_approval`, `task_approve`, `task_reject`, `task_pending_approvals`, `task_review_cycle` merged into `task_approval(action: "request"|"approve"|"reject"|"list"|"review")`
  - `task_add_collaborator`, `task_remove_collaborator` merged into `task_collaborator(action: "add"|"remove")`
  - `task_add_dependency`, `task_remove_dependency` merged into `task_dependency(action: "add"|"remove")`
- Domain layer unchanged — only MCP transport layer refactored

## [1.8.0] - 2026-03-29

### Added

- **Learnings Propagation** — new `task_learn` MCP tool for capturing insights on tasks (categories: technique, pitfall, decision, pattern). On `task_complete`, learnings auto-propagate to the parent task and in-progress sibling subtasks with attribution.
- **Agent Affinity** — `task_next` now accepts an `agent` parameter for affinity-based routing. Among same-priority tasks, prefers tasks where the agent worked on the parent, a dependency, or the same project. Returns `affinity_score` and `affinity_reasons` in the response.
- Dashboard: dedicated "Learnings" section in the side panel with lightbulb icon, category badges (technique/pitfall/decision/pattern), and source attribution for propagated learnings.
- Dashboard: CSS styles for learning cards with amber accent color.

### Changed

- MCP tool count: 32 → 33
- `task_next` response now includes `affinity_score` (number) and `affinity_reasons` (string array)

## [1.7.0] - 2026-03-29

### Added

- **Stage Gate Guards** — `GateConfig` now supports per-stage rules via `gates` field. Each stage can require named artifacts (`require_artifacts`), minimum artifact count (`require_min_artifacts`), comments (`require_comment`), or approvals (`require_approval`) before a task can advance. Configure via `task_pipeline_config`.
- **Decisions Log** — new `task_decision` MCP tool for recording structured decisions (chose X over Y because Z) as artifacts. Creates a formatted markdown artifact at the current stage.

### Changed

- MCP tool count: 31 → 32

## [1.6.0] - 2026-03-25

### Added

- GitHub Actions CI with npm auto-publish on tag
- Clean CHANGELOG

### Changed

- Prepared for open-source release on GitHub
- Removed all internal references

## [1.5.0] - 2026-03-25

### Added

- Comprehensive documentation (README, setup guide, API reference, dashboard guide, hooks guide)
- 7 dashboard screenshots
- Cleanup dialog with 3 options: purge completed, purge all done, purge everything

## [1.4.0] - 2026-03-25

### Added

- Syntax highlighting for code artifacts (highlight.js)
- Markdown rendering (marked + DOMPurify)
- Expandable/collapsible artifacts
- Side-by-side diff viewer
- Status badges on task cards
- Resizable side panel with fullscreen artifact viewer
- Loading skeleton placeholders

### Fixed

- Card flicker on state updates (morphdom keying)
- CSP headers for CDN libraries
- isDiff detection accuracy

## [1.3.0] - 2026-03-25

### Added

- Side panel detail view
- Rich task cards with avatars, description preview, relative time
- Inline task creation and editing
- Stage-colored columns with Material Symbol icons
- Collapsible columns, WIP indicators
- MD3 design token alignment

## [1.2.9] - 2026-03-25

### Added

- Health endpoint optimization (COUNT(\*))
- REST input validation, PUT /api/tasks/:id
- Rate limit cleanup, event bus logging
- 338 tests across 12 test files

### Fixed

- Rate limiter memory leak
- getDependencies validation
- fail() transaction wrapper
- CORS on 429 responses

## [1.2.0] - 2026-03-25

### Added

- Real-time kanban dashboard with WebSocket
- TodoWrite bridge hook
- Approval workflows
- Auto-assignment, review cycles

## [1.1.0] - 2026-03-25

### Added

- Multi-agent collaboration, subtasks, search
- Drag-and-drop, filters, keyboard shortcuts
- Full-text search (FTS5)
- Artifact versioning, threaded comments
- Dark/light theme
