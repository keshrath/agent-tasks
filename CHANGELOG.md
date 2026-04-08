# Changelog

All notable changes to this project will be documented in this file.

## [1.10.0] - 2026-04-09

### Added (from c237c69 — original commit being amended)

- **`scoreTaskConfidence`** (src/domain/confidence.ts): pure heuristic 0-100 score over title + description (length, lists, headers, file refs, acceptance language). No LLM calls.
- **`GateConfig.min_confidence_for_claim`**: optional per-project threshold; `TaskService.claim` throws `ValidationError` with reasons when a vague task is claimed. Backward compat — disabled by default.
- **`GateConfig.stage_instructions`**: optional per-stage prompt strings; `TaskService.getStageInstructions` exposes them, MCP `task_stage` handler augments claim/advance responses with a `stage_instructions` field when configured.
- 6 unit tests (confidence), 9 integration tests (gate + instructions), 2 e2e tests (full pipeline run with both features).
- `docs/API.md` documents both new GateConfig fields with examples.

### Added — bench harness

- **`bench/`** — quantitative bench harness for the pipeline coordination layer, mirroring the agent-comm bench. Pure metric calculators (`metrics.ts`) with 20 unit tests, mock + real Claude CLI driver (`drivers/cli.ts`) that pre-seeds tasks via `TaskService` into a shared SQLite DB injected per-agent through `AGENT_TASKS_DB`, runner with `--real` / `--pilot` / `--n-runs=N` selection, and persisted results in `bench/_results/`.
- **Throughput pilots** — 4 fixtures testing `task_stage claim` against naive parallel agents at varying work-unit sizes:
  - `task-claim-race` (6 tiny TODO functions, $0.50/agent) — N=3 result: **MARGINAL** (4.3/6 vs 3.7/6, identical units/$ ~2.84). The atomic claim primitive prevents some collisions but the fixture is too small for the gain to justify the cost.
  - `dependency-graph` (6 files in a real DAG, 3 conditions: naive / flat-claim / dep-aware) — N=3 result: **INCONCLUSIVE**. At $0.50 every condition hits the 5/6 ceiling; at $0.25 the MCP-based conditions floor at 0/6 because protocol overhead consumes the entire budget. Fixture cannot measure what it claims to measure.
  - `cross-session-pipeline` (2 sequential agents handing off via SQLite, $0.30/agent) — N=3 result: **INCONCLUSIVE**. Naive 6.0/6 vs claim 1.0/6 — protocol overhead exceeds the per-agent budget. Fixture too small.
  - **`realistic-funcs`** (3 parallel agents, 4 non-trivial 50-150 LOC functions: parseCsv, stringifyCsv, diffObjects, renderTemplate, $1.50/agent) — N=3 result: **WIN ⭐**. agent-tasks-claim hit **4/4 deterministically every run** vs naive 3.3/4. +20% units/$, 6% faster wall, identical cost, 100% individual pass rate vs naive 67%. First fixture where agent-tasks's structured pipeline measurably wins on throughput.
- **Cross-cutting throughput finding**: MCP protocol overhead (~$0.15 per task = ~3 roundtrips × $0.05) dominates on small work units. agent-tasks's pipeline only pays off when work-per-task ≥ ~$0.30; below that, naive wins. Documented in `bench/README.md` with a break-even table and explicit production guidance: use agent-tasks for multi-stage durable work, not for tiny throwaway TODOs.

### Added — visibility bench (the headline result)

- **`bench/visibility/`** — a structurally different bench that measures **manager visibility**, not throughput. Builds a frozen mid-feature project state and asks a single "manager" agent (with no prior context) 10 standardized questions about it. Two conditions: (a) **naive** — the manager has only the file system; (b) **agent-tasks** — the manager has `task_list` / `task_get` with artifacts and comments. Auto-graded against a known answer key.
- **Two scenarios** in a registry (`bench/visibility/scenarios/`):
  - **`csv-export`** — 6 tasks, mid-build snapshot (3 workers adding CSV export to a TODO app, minute 8 of an estimated 15-minute build). Tests **live state visibility**: who's working on what, what's blocked, what's idle, what's left, why was X chosen.
  - **`audit-recall`** — 8 tasks, all done. A "30-day-old" completed feature build (rate-limit added to auth endpoint), with full spec/decision/test-results/review-notes artifacts. Tests **historical provenance**: who wrote the spec, why was sliding window chosen over token bucket, how many tests passed, what concern did the reviewer raise.
- **N=2 result, both scenarios:**
  - csv-export: **naive 3.0/10, agent-tasks 10.0/10 ⭐** (perfect across both runs)
  - audit-recall: **naive 2.0/10, agent-tasks 10.0/10 ⭐** (perfect across both runs)
  - Cross-scenario aggregate: naive **2.5/10 (25%)** vs agent-tasks **10.0/10 (100%)** — **+7.5 score delta, 4× advantage** at ~$0.37 per query.
  - Total visibility-bench spend: **~$2.40 for 8 manager invocations** — produced the strongest evidence in the entire v1.10 cycle for one tenth the cost of the throughput sweep.
- **What this proves**: agent-tasks's value is **management visibility for humans running fleets of agents**, not raw agent throughput. The naive manager cannot answer questions whose answers live in artifacts (specs, decisions, test results, review notes) or in task metadata (blocked, idle, count, backlog). agent-tasks captures all of these. The bench validates the LinkedIn pitch directly.

### Changed

- **`bench/README.md`** — full methodology with the throughput break-even table, both visibility-scenario results, the production-feedback section, an explicit negative-results policy, and a section on why naive wins on tiny workloads but agent-tasks wins on management questions.
- **Production guidance** added: **DO** use agent-tasks for multi-stage durable work, multi-session features, work needing audit trails or human review at gates. **DON'T** use it for tiny throwaway TODOs in a single session — naive parallelism is cheaper.
- **`tsx`** added as a devDep for running `bench:run` and `bench:visibility`.

### Notes

- v1.10.0 ships as the consolidated bench-evaluation release. CHANGELOG covers the original c237c69 feature work + the entire bench harness + the throughput pilots + the visibility bench v2 in a single entry. Total bench spend during evaluation: ~$33.

## [1.9.29] - 2026-04-08

### Documentation

- Self-documenting release: documents this version + retroactively records the 1.9.28 release whose payload was the 1.9.19 – 1.9.27 backfill.

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
