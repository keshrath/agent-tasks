# agent-tasks

## Architecture

Layered architecture with explicit dependency injection (no global state):

```
src/
  index.ts    MCP stdio entry point; one process serves the REST API (leader election on the port; the others retry and take over)
  server.ts   REST server (standalone: node dist/server.js [--port] [--db])
  domain/     tasks (stages, dependencies, artifacts, claiming), events, validation
  storage/    SQLite (better-sqlite3, WAL mode)
  transport/  REST (node:http, JSON only) + guard.ts (Host/Origin/Content-Type), MCP (official SDK `Server` over stdio, mcp.ts)
plugin/       Claude Code plugin (.mcp.json + one mod: hooks/register.tsx + view.tsx = /pipeline pane)
```

- **No frameworks** — no React, Vue, Express. Pure Node.js + TypeScript; runtime deps are the official MCP SDK (`@modelcontextprotocol/server`) and better-sqlite3. No agent-common.
- `context.ts` is the DI root — wires all services together.
- `src/` stays host-agnostic; Claude-specific glue belongs in `plugin/` (the mod). There are no command hooks (removed in 3.0).
- **Soft deps**: `AgentBridge` → agent-comm (notifications), `KnowledgeBridge` → agent-knowledge (push learnings/decisions on task completion). Both HTTP-only, fail-open.

## UI surfaces

There is no web dashboard (removed in 2.0, with the WebSocket, the UI files and the agent-desk plugin).

- **Claude Code pane** (`plugin/hooks/register.tsx` + `view.tsx`, Claude Code 2.1.289+ function hooks): `/pipeline` opens it (the built-in `/tasks` is taken); `/pipeline 12` opens task 12, `/pipeline <text>` filters the board. Tabs Board (open tasks by stage, Find over id, title, agent, project and tags, `waits for #N` on blocked rows), Done (recently closed, who and where, the result beneath), New (title, project, priority, tags, description of 3 rows; Tab walks the fields, Enter in any creates: an Enter-walk moved the ring after the keypress and lost what was typed meanwhile). Task detail: stage strip, actions for a task in progress (Advance › next, Complete, ‹ Send back with a stage, Fail; Cancel, Delete with a confirmation), Reopen for a finished one (`task_stage` action `reopen`), facts, description, subtasks, artifacts (unfold as Markdown), comments + a comment field. No Claim: agents claim with `task_stage`; an unclaimed task has no Advance either (it would sit in progress with nobody on it). A blocked task shows no Advance or Complete (the domain refuses both while a `blocks` dependency is open), only what it waits for; nor does a task whose gate wants artifacts or an approval (`isOutOfReach`: nothing the pane can give). Delete asks naming the finished subtasks it takes along (`subtree` from `task_get` include subtasks); with an open subtask below it the box says which and offers only Back (the domain refuses such a delete). A stage gate is said under the actions from `task_get`'s `gate_needs` (`TaskService.gateNeeds`, the gate's one reader; `checkStageGate` refuses Advance and Complete on it), said with who gives it (`gateHint`); Advance and Complete lose `primary` while it holds. The ring never lands in a text field by itself (a later `/pipeline N` would be typed into it and posted): not when `/pipeline` opens or moves to a view, not after a comment, not after a gate refusal (`unlessGated` says `✗ #N can't leave <stage> yet: add the comment below` and lands on `back` after Advance, on the form's Never mind after Complete, the form staying open with its words and the hint under it); a tab switch lands on the tab, and the New tab's digit or button pressed again (`wantsTyping`) puts it in Title; Clear lands on Clear and drops `wantsTyping`. A tab pressed while the server is down changes nothing and says so. A stage nobody works on folds past 5 rows (`boardGroups`; board folds survive opening a task); unfolded, its toggle stays after row 5 and the ring goes to the first row it showed. A fresh board lands on its first task in progress (a find on its first match). Status line entry and the board's summary are the same text (`headline()` in view.tsx); toasts only for tasks that finished or reached review since the last poll; one `prompt.context` block (once per conversation) with what is in flight, this session's claims first and marked, asking to claim only with `enforcePipeline` on. The outcome of the pane's own act shows under the tabs and in the status entry while it lasts (`showStatus`); ✓ done, – dropped (cancelled, marked failed), ✗ refused. `/pipeline` answers no text unless something went wrong (no board, no such task, a find matching nothing, no pane): a plugin command's text also goes to the model. Artifact Markdown gets `fitTables` (a table wider than the pane one row a line, as agent-knowledge does). While the pane holds the keyboard the board and Done keep their drawn order (`pinned`, `pinOrder`; new rows at the end of their stage or of Done), sorted afresh on a fresh open, a tab, a find, or once the keys are the prompt's. A poll of a pane holding the keys writes through `commit`: when the controls change (`drawnState` before and with the new data), the ring is parked on Refresh, the state written, the drawing awaited (`afterDraw`: Refresh's key carries `frame`), then `reland` puts it back on its key while drawn and safe (`isGone`), else lands it: on the board as on a fresh open, in a task on `back`. A ring in a text field stays there (parked, typed keys would hit hotkeys) and is put back once drawn; while the person typed within `TYPING_MS` (1.5 s) nothing is written at all (the status entry says it waits) and it is drawn as soon as they stop (`drawOnceIdle`). Fields are uncontrolled while typing: `typed` (New) and `formTyped` (a form) record keys outside the drawn state; `draft` and a form's `seed` are drawn only when a field is made anew (tab switch, refusal, Clear, words offered back), as a value drawn on each key would replace keys typed fast. An action form whose task changed elsewhere (moved, finished, or a Complete whose task came to wait for another) closes (`closeStaleForm`), keeps its words for the same button (`unsent`) when that button is drawn again, and lands the ring on it (`afterStale`), else `back`. Send back starts on its stage picker (`form-stage`) and Enter in its empty Why sends nothing; picking the first stage says the task is unclaimed there. Advance sends the stage it was drawn in (`from`): a task moved elsewhere is refused (`! #N moved elsewhere`), and refusals leave out the server's advice to agents (`refusal`). Every landing yields to a newer claim: `claims` counts the person's moves (`ui.focus` not from the plugin) and every press (the `actions` wrapper), and `focusOn(key, since)` drops a move whose claim is stale. `isRisky` keys (Advance, Reopen, Delete #N, a form's send, Create) are never landed on, whoever asks. Every navigation (`go`, `open`, `back`) parks the ring on Refresh (`park`) before it writes the route, and a task opens loading, never with the last one's controls. A press on a guarded control (`isGuarded`: the risky ones, Complete, the buttons that open a task's forms, Delete) within `PRESS_GUARD_MS` (0.4 s) of a change of the controls (`viewChanged`, set by every navigation and act, and by a poll that changes the controls of the view shown), or while an act runs, is taken in `ui.press` and said (`press it again`): a second Enter on a row pressed whatever the task view drew at its place. A landing that yielded to a newer press still lands when that press left the ring parked (`isParked`). A press that reaches a button whose drawing was replaced as it came (its handler gone: the engine throws) is never lost: a move between views (a tab, a row, a fold, back, Refresh) is done anyway, anything else says `press it again`. Every press is traced to the debug log (`--debug-file`; the e2e harness writes one per session to `AGENT_TASKS_E2E_DEBUG_DIR`): its key, the time since the controls changed, the ring, and what came of it. `go` reads the tab asked for last (`requested`), so `3` twice fast puts the ring in Title. A task opens on `back` (`dep:<id>` when blocked), never on Advance or Complete; a local Advance and a sent-back task land on `back`, a sent comment on the comments' fold (else `back`, the comment scrolled into view); a gate refusal lands as `unlessGated` says above; Refresh keeps the ring. A refused action form draws its words back under a new field key (`formKey`, `drawn`). The tasks this session holds (`mine`, from the holder beats) are marked `this session`. An agent that never named itself acts as its MCP client and project (`claude-code@agent-tasks`, the server's `sessionName` fallback), not `system`. An empty Done lands on its `[ Board ]` button (`empty-board`). Busy acts draw a `Progress` line with a gerund label (`Advancing #12`), failures `✗ <label> failed: …`. Session hooks (`docs/hooks.md`): the session is a claim holder `claude:<session id>` (beats on session.start and every 30 s, adopts each successful `task_stage` claim/assign through `tool.call`, ends on `session.end`); with the `enforcePipeline` userConfig option, `prompt.submit` adds `PIPELINE_REMINDER` (`work.ts`) to a person's work prompt while the session holds no open task, decided with no request: from `mine` once a beat answered (`isMineKnown`; a `task_stage` complete, fail or cancel and every act of the pane beat again, so a session that finished its only task is reminded), as nothing for a new conversation (no assistant message yet, no /clear carry-over), and only for a resumed one by waiting on its first beat (fails open). Acts as `AGENT_TASKS_USER`, else the OS user (`created_by`, comment author, `by`). Polls `GET /api/board` every 5 s while open, 30 s while closed. REST only, through `$.http.fetch` on `AGENT_TASKS_PORT` (default 3422), every string of every answer made drawable where it enters (`printable` in `api()`'s JSON reviver, and on tags parsed from their JSON text): escape sequences go, other control characters become `�`, as one in a drawn text makes the CLI refuse the whole pane; each request given up after `FETCH_TIMEOUT_MS` (3 s) and failing open. View state in `$.state` (contract `plugin/types/index.d.ts`). Opened as a plain sidebar (no `closeOnEscape`); `/pipeline` reports `isPlaced: false` with the reason. Focus lands explicitly after every navigation and action, a fold's toggle included (`landing()`, `toggle()` in register.tsx): the engine keeps the ring at its place in the focus order across a redraw, not on a key, so a redraw that adds or drops a control above it would move it; a key that names the new state (`foldKey`, `complete:<stage>` from `completeKey`, the fresh `comment:<rev>`, Refresh's `refresh:<frame>` from `refreshKey`) makes the focus wait for the drawing that shows it; `land` first waits on Refresh (`afterDraw`), a button, so nothing typed meanwhile lands in a field and a key both drawings have (a Done row that was a board row) is not focused on the old one. Back up after the server was away, the ring returns where it was before (`landBack`), else lands as on a fresh open. The pane's own moves and its autoFocus taking the ring both reach `ui.focus` as origin `plugin`; `focusOn` marks its own (`ownMoves`, a set: moves overlap), so a take (ctrl+x tab) is put back on the last `focused` key while it is drawn, and `openPane` clears `focused` so a command's view starts at its landing. The element `landing()` names is also drawn `autoFocus`, and `/pipeline` closes and reopens an open pane after setting the view, because a take would otherwise put the ring back on the element it last held. Every function that takes `$` must be a top-level declaration (`claude plugin validate` enforces it). Tests: `plugin/tests/*.test.ts` under `claude plugin test plugin` (`npm run plugin:check`); vitest excludes `plugin/`. Type-check with a tsconfig outside the folder (never `tsc -p plugin`, it emits .js into plugin/).
- **MCP tool results** (JSON + the pipeline footer) for every other host.

## Code Style

- No inline comments — only file-level section headers (`// === ... ===` or `// --- ... ---`)
- No Co-Authored-By or Claude branding in commits
- ESLint + Prettier enforced via lint-staged (husky pre-commit)

## Versioning

- Version lives in `package.json` and is read at runtime (REST `/health`, MCP `initialize`)
- Never hardcode version strings
- `package.json`, `server.json` (top-level and package entry) and `plugin/.claude-plugin/plugin.json` stay on the same version (`tests/manifest.test.ts`); `plugin/.mcp.json` pins the major (`agent-tasks@^3`)
- Every commit must bump the patch version minimum; patch bumps get no CHANGELOG entry, feature releases do
- Commit message format: `vX.Y.Z: short description`

## Build & Test

```
npm run build         # tsc
npm test              # vitest (unit + integration)
npm run check         # typecheck + lint + format + test
npm run plugin:check  # claude plugin validate + test (needs the claude CLI)
npm run e2e:claude    # the /pipeline pane in the real Claude Code CLI (tests/e2e-claude/, screenshots; drive.ts to steer one by hand)
npm run manual:record # docs/images/manual/: the manual's stills (PNG) and flows (GIF, gifenc) from the real CLI (tests/e2e-claude/manual.ts + record.ts)
npm run dev           # tsc --watch
```

## Pipeline Stages

Default: `backlog → spec → plan → implement → test → review → done`

Configurable per project via `task_config` (`action: "pipeline"`). Tasks advance through stages sequentially; dependencies block advancement until resolved.

## Key APIs

- **REST** (10 routes, only what the pane and the plugin call; loopback; the request guard in `src/transport/guard.ts` checks Host against the port, refuses any request carrying an `Origin`, and wants JSON bodies): `GET /health`, `POST /api/tasks`, `GET/DELETE /api/tasks/:id` (the `task_get` shape, `?include=subtasks,comments,transitive_deps`), `POST /api/tasks/:id/stage` (the `task_stage` actions, `by` = who acts), `POST /api/tasks/:id/comments`, `GET /api/board` (what the pane polls), `GET /api/pipeline`, `POST/DELETE /api/holders/:holder` (a host session as claim holder). Full list: `docs/API.md`
- **MCP** (8 tools): `task_create`, `task_get` (include subtasks/artifacts/comments/transitive_deps), `task_list` (search via `query`, pick next via `next: true`), `task_update` (metadata + dependencies), `task_delete`, `task_stage` (claim/assign/advance/regress/complete/fail/cancel), `task_artifact` (general/decision/learning/comment), `task_config`

## Live Updates

Every MCP process writes the same SQLite DB (WAL). The REST server reads it on each request, so the `/pipeline` pane sees changes from any session on its next poll.

## Domain Model

- **Task**: id, title, description, status (pending/in_progress/completed/failed/cancelled), stage, priority, project, assigned_to, holder, parent_id, tags, result, closed_from (the stage a completed or cancelled task was closed in: where `reopen` puts it), created_by, created_at, updated_at. A delete takes finished subtasks (all levels) along and is refused while any is open (`descendants`)
- **Claim holder** (`HolderService`, table `holders`): what a task in progress lives with (only `in_progress` is held). Each MCP process is one (`mcp:<uuid>`, `keep()` beats and sweeps every 30 s); a host session can be one over REST (`/api/holders`, the plugin's `claude:<session id>`). Claim, assign and advance through a process or session set the holder; `task_config` session `reclaim`s that name's tasks nothing alive holds. A holder ended or silent past `AGENT_TASKS_DEAD_SESSION_GRACE_MINUTES` (10) fails its tasks in progress; never activity, never agent-comm. Reassigning a task clears its holder; a REST claim has none. Write transactions are IMMEDIATE (`Db.transaction`), migrations too
- **Status transitions**: pending -> in_progress (claim; only an unblocked pending task, the same rule `claim_status.claimable` reports), in_progress -> completed/failed, any non-terminal -> cancelled
- **Stage transitions**: Sequential through pipeline; regress allowed to any earlier stage (back in the first stage the task is unclaimed again); dependencies block advancement
- **Artifact**: name + stage + task_id = identity; version auto-incremented, previous_id links history
- **Comment**: threaded via parent_comment_id; agent_id tracks author
- **Collaborator**, **Approval**: tables and library services (`ctx.collaborators`, `ctx.approvals`) that no MCP tool or REST route writes; a `require_approval` gate therefore cannot be passed through the tools
- **Dependency**: task_id -> depends_on_id + relationship (`blocks` forms a DAG with cycle detection and is the only kind that blocks or shows as blockers/blocking; `related`, `duplicate` show as `links` with a direction; one row per task pair)

## Error Handling

Custom error hierarchy in `src/types.ts`:

- `TasksError` (base, 400) -> `NotFoundError` (404), `ConflictError` (409), `ValidationError` (422)
- Always use these instead of plain `Error` — the MCP transport formats them for tool responses

## Testing

- Framework: vitest with global test functions
- Test files: `tests/*.test.ts`, end-to-end MCP flows in `tests/e2e/` (all vitest); the pane's tests in `plugin/tests/` (claude plugin test); the pane in the real CLI in `tests/e2e-claude/` and every MCP tool through `claude -p` (`mcp.e2e.test.ts`) (vitest, skipped unless `AGENT_TASKS_E2E_CLAUDE=1`); the stdio entry point in `tests/stdio.test.ts`, a 1.x database fixture in `tests/fixtures/`
- In-memory SQLite via `createTestContext()` from `tests/helpers.ts`
- Each test gets a fresh context in `beforeEach`, closed in `afterEach`
- Pattern: Arrange-Act-Assert with descriptive `describe`/`it` blocks

## Database

- SQLite with WAL mode, better-sqlite3
- Schema versioning via `_meta` table (current: V7)
- Migrations: the version-ordered `migrations` array in `src/storage/database.ts` (own runner, version in `_meta.schema_version`); add a new entry, never edit an old one
- All tables use FK constraints with `ON DELETE CASCADE`
- FTS5 virtual table for full-text search with triggers for sync
