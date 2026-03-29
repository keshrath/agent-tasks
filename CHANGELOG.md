# Changelog

All notable changes to this project will be documented in this file.

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
