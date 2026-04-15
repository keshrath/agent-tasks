# Privacy Policy — agent-tasks

**Last updated:** 2026-04-15

## What data this plugin accesses

- **Local filesystem only.** Maintains a local SQLite database at `~/.claude/agent-tasks.db` (configurable via `AGENT_TASKS_DB`) holding tasks, stages, dependencies, per-stage artifacts (specs, plans, test results, decisions, learnings, comments, review notes), claimer assignments, approvals, and collaborators.
- **Runs a local dashboard.** An HTTP + WebSocket server binds to `http://localhost:3422` (configurable via `AGENT_TASKS_PORT`) for the Kanban dashboard and REST API. Never exposed to the public internet by this plugin.
- **No telemetry.** The plugin does not collect or transmit usage data.
- **No server-side storage by us.** All data stays on your machine.

## KnowledgeBridge (opt-in; localhost only)

When agent-knowledge is also installed and its dashboard is running, `agent-tasks` can forward `learning` and `decision` artifacts to the local agent-knowledge dashboard via HTTP (`POST http://localhost:3423/api/knowledge`) on task completion. The bridge fails open if the target is unreachable. No data leaves your machine — both services bind to localhost.

## Content you provide

Task titles, descriptions, artifact bodies, and comments are stored verbatim in the local SQLite DB. They are not scrubbed, indexed by third parties, or transmitted anywhere by this plugin. You control what goes in.

## Data retention

- Tasks, artifacts, comments, dependencies: persisted locally until you delete them via `task_delete` or the dashboard.
- Automatic cleanup: orphaned tasks from dead sessions (no matching PID) are auto-failed by the `SessionStart` / `Stop` hooks when installed.
- FTS5 full-text search index: rebuilt automatically from task content; no separate data copy leaves the DB.

## Contact

Issues and security reports: <https://github.com/keshrath/agent-tasks/issues>
