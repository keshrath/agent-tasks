# Changelog

All notable changes to this project will be documented in this file.

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
