# /pipeline pane: e2e coverage in the real Claude Code CLI

Every control, key, command form, view state, notice, toast and output a person can reach, and the test that drives it in the real CLI (`npm run e2e:claude`). `pane` = `pane.e2e.test.ts`, `board` = `board.e2e.test.ts`, `detail` = `detail.e2e.test.ts`; the test is named after the `>`. Layouts: **F** fullscreen dock at 160 columns, **N** the narrow dock at 110, **I** inline at 120.

## Command forms

| What                                                | Covered by                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/pipeline`: opens the pane, no transcript line     | board > /pipeline opens the pane and puts no line in the transcript…; pane > opens on the board by stage |
| `/pipeline <id>` and `/pipeline #<id>`              | pane > /pipeline <id> opens a task; Advance moves it on (`#id`); pane > a task in its last stage… (`id`) |
| `/pipeline <unknown id>`: says so, shows the board  | board > /pipeline <unknown id> says there is no such task and shows the board                            |
| `/pipeline <text>`: filters, answers with the count | pane > Find narrows the board…; pane > /pipeline <text> lands on the first match every time              |
| `/pipeline <text>` matching nothing                 | board > /pipeline <text> that matches nothing lands on Clear the filter                                  |
| `/pipeline` while the pane is open                  | pane > /pipeline <text> lands on the first match every time (12 times, the pane open and polling)        |
| `/pipeline` after the pane was closed               | board > the ✕ closes the pane; /pipeline opens it again on the board                                     |
| `/pipeline <id>` drops the text the last find kept  | pane > Find narrows the board by text, a project name too                                                |
| `/pipeline` while the server is down                | resilience > the server goes away and comes back: down and up again without a key                        |

## Board

| What                                                                                                                          | Covered by                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Summary line (open, in progress, blocked)                                                                                     | pane > opens on the board by stage                                                                                 |
| Stage counts, in pipeline order                                                                                               | board > /pipeline answers with the board summary…; board > a project with its own stages…                          |
| Sections by stage; in progress first, then priority, then oldest                                                              | board > /pipeline answers with the board summary and opens the pane                                                |
| Row marks: ● in progress, ○ pending, ! blocked                                                                                | pane > opens on the board by stage                                                                                 |
| Row facts: waits for, assignee/unclaimed, subtasks, part of, project                                                          | pane > opens on the board by stage                                                                                 |
| Priority marks: p5+ coloured, lower dim, none for p0                                                                          | board > priority marks…                                                                                            |
| Custom per-project pipeline: sections after the default stages                                                                | board > a project with its own stages gets sections after the default ones                                         |
| Custom pipeline in a task's stage strip                                                                                       | board > a project with its own stages… (opens the proof task)                                                      |
| Long title: cut on one line, priority beside it                                                                               | board > a long title is cut on its one line (F); board > board rows stay two lines (N)                             |
| Wide (CJK, emoji) title on one line                                                                                           | board > a title with wide characters stays on one line (F); board > board rows stay… (N)                           |
| A long board (62 tasks): Tab scrolls the pane with the ring                                                                   | board > a project with its own stages… (Tab to the last section)                                                   |
| ↑ ↓ scroll the pane, the ring stays                                                                                           | board > ↑ and ↓ scroll the board without moving the ring                                                           |
| A long backlog folds past 5 rows (`▸ N more`), unfolds (toggle stays after row 5, ring on the first row shown) and folds back | board > the long backlog folds past five rows; Enter unfolds it and folds it again; plugin > a long backlog folds… |
| Empty board: says so, New task button, its landing                                                                            | board > says nothing is open and offers a new task                                                                 |
| Empty board with recent work points at Done                                                                                   | board > once all is finished the board points at Done                                                              |
| Finished tasks are not on the board                                                                                           | pane > opens on the board by stage                                                                                 |

## Find

| What                                               | Covered by                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| By title text, by project                          | pane > Find narrows the board by text, a project name too                           |
| By `#id`, by agent, by tag (row says `tag <name>`) | board > Find matches an id, an agent and a tag, and says which tag                  |
| `N shown` in the summary                           | pane > Find narrows…; board > Find matches…                                         |
| No match: "No open task matches."                  | pane > Find narrows…; board > /pipeline <text> that matches nothing…                |
| Clear the filter (keyboard)                        | pane > Find narrows…; board > Find matches…; board > /pipeline <text> that matches… |
| Ring lands on the first match after a find         | pane > Find narrows…; pane > /pipeline <text> lands on the first match every time   |
| `r` and digits are text inside the field           | board > Find matches… (`r`); pane > digits switch Board, Done and New… (digits)     |

## Done

| What                                                     | Covered by                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Newest first; ✓ ✗ – marks; who, where, result beneath    | pane > Done lists what finished, newest first, its result beneath                |
| Its digit again lands on the newest                      | pane > Done lists what finished…                                                 |
| A row opens its task; back lands on the row              | pane > Done lists what finished…                                                 |
| Empty: "Nothing finished yet."; digit lands on Board tab | board > Done says nothing finished yet; its digit again lands on the Board tab   |
| Narrow and inline                                        | board > Done rows keep who, where and the result… (N); board > Done and New… (I) |

## New

| What                                                                           | Covered by                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Tab walks Title → … → Description at typing speed, nothing lost; Enter creates | pane > New: Tab walks the fields at typing speed…                                                              |
| Priority not a whole number: said beneath, ring kept                           | pane > New: Tab walks the fields…                                                                              |
| Created: `✓ created #N` on one line, the task opens                            | pane > New: Tab walks the fields…; board > New from the empty board…                                           |
| REST state: title, project, priority, tags, created_by                         | pane > New: Tab walks the fields…; board > the mouse… (created_by)                                             |
| Create button                                                                  | board > New from the empty board creates the first task                                                        |
| Clear button: empties, the ring stays on Clear                                 | board > New: Clear empties what was typed and keeps the ring on Clear (N); pane > Clear on New lands on Clear… |
| Field hints fit beside their labels                                            | board > New: every field hint fits beside its label (N)                                                        |
| Inline                                                                         | board > Done and New draw inline too                                                                           |

## Keys and focus

| What                                                                              | Covered by                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `1` `2` `3` switch tabs; the shown tab's digit lands its first row                | pane > digits switch Board, Done and New while the pane holds the keyboard                        |
| Typing header in a field (digits dropped, "Tab leaves…"; "Tab next field" in New) | pane > digits switch… (New); board > Tab and shift+Tab walk the rows; above the first row is Find |
| Tab / shift+Tab order on the board                                                | board > Tab and shift+Tab walk the rows…                                                          |
| Esc: keys to the prompt, "ctrl+x tab…" hint, digits typed there                   | board > Esc gives the keyboard to the prompt; ctrl+x tab takes it back                            |
| ctrl+x tab: keys back, ring where the person left it                              | board > Esc gives the keyboard…                                                                   |
| `r` refreshes (up)                                                                | board > r refreshes: a task another session made shows at once                                    |
| `r` refreshes (down), "still no board (time)"                                     | pane > says so instead of showing a stale board…                                                  |
| Back from a board task lands on its row                                           | board > back from a task opened on the board lands on its row                                     |
| Enter opens a row (inline)                                                        | board > the board takes the keyboard: rows open with Enter                                        |

## Mouse (fullscreen)

| What                                      | Covered by                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Tabs (Board, Done, New), Refresh          | board > the mouse: tabs, rows, the back link, Refresh and the New form  |
| A row opens its task; `‹ Board` goes back | board > the mouse…                                                      |
| New: click a field, type, click Create    | board > the mouse…                                                      |
| ✕ closes the pane                         | board > the ✕ closes the pane; /pipeline opens it again on the board    |
| Detail and form buttons                   | detail > by mouse (every action, form submit, Never mind, related rows) |

## Status entry, context block, toasts

| What                                                                | Covered by                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Status entry = board summary, updates on change                     | pane > the status entry says what the board says; pane > changes from other sessions…   |
| Status entry with an empty board, after the first task              | board > says nothing is open…; board > New from the empty board…                        |
| Status entry stays while the pane is closed                         | board > the ✕ closes the pane…                                                          |
| Status entry `offline`                                              | pane > says so instead of showing a stale board…                                        |
| Context block the model is given (in progress, pending by priority) | board > the model is given what is in flight, highest priority first (asks the model)   |
| Toast: done + ready for review in one                               | pane > changes from other sessions toast and update the status entry                    |
| Toast: failed                                                       | board > toasts: a failure says so, a cancellation does not, more than three are counted |
| No toast for a cancellation                                         | board > toasts…                                                                         |
| `+N more` past three                                                | board > toasts…                                                                         |
| No toast for the pane's own acts                                    | detail > what the pane does itself is not toasted                                       |

## Layouts

| View  | F                                 | N                                                                | I                                                                              |
| ----- | --------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Board | pane, board                       | pane > board, detail, forms…; board > board rows stay two lines… | pane > opens the board above the prompt; board > the board takes the keyboard… |
| Done  | pane > Done lists…                | board > Done rows keep who…                                      | board > Done and New draw inline too                                           |
| New   | pane > New: Tab walks the fields… | board > New: every field hint fits…                              | board > Done and New draw inline too                                           |

## Detail

`resilience` = `resilience.e2e.test.ts`.

| What                                                                                       | Covered by                                                                                    |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Status line (mark, word, agent, priority, project), stage strip                            | pane > a task in progress…; detail > an unclaimed subtask…; detail > a completed task…        |
| Created (by whom) / Updated, Tags                                                          | detail > an unclaimed subtask…; pane > a task in progress…                                    |
| Result / Error / Reason fact                                                               | detail > a completed task…; pane > Done lists… (Error); detail > a cancelled task… (Reason)   |
| Cancelled: no stage strip                                                                  | detail > a cancelled task: its reason, no stage strip                                         |
| Completed: Reopen and Delete, no Artifacts section                                         | detail > a completed task: its result, the strip at done, Reopen and Delete left              |
| Failed (session gone) → Reopen: unclaimed at its stage, `reopen` artifact, ring on ‹ Board | detail > a failed task opens again with Reopen…                                               |
| Unclaimed hint, no Advance/Complete/Fail/Send back, ring on `‹ Board`                      | detail > an unclaimed subtask: its parent, who made it, no step to take, the way back         |
| Assigned pending: "Waiting for <agent> to start it."                                       | detail > an assigned task waits for its agent                                                 |
| Custom pipeline: strip and `Advance ›` name its stages; Complete at the last               | detail > a project with its own pipeline: the strip and Advance name its stages               |
| Blocked: no Advance/Complete, "It moves on once…", ring on the blocker                     | pane > a blocked task cannot move on…; detail > blocker → its subtask → back…                 |
| Related / Duplicate links shown, never blocking                                            | detail > a related link does not block: Advance stays; detail > a cancelled task… (Duplicate) |
| Part of (parent), Subtasks n/m done                                                        | detail > an unclaimed subtask…; detail > blocker → its subtask → back…                        |
| Related-task navigation and the back trail (`‹ #N` … `‹ Board`)                            | detail > blocker → its subtask → back, back, back to the board                                |
| Description fold (`▸ Show all N lines` / `▾ Show less`), ring kept                         | pane > a task in progress…                                                                    |

## Actions and forms

| What                                                                   | Keyboard                                                     | Mouse                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| Advance › next (names its target stage)                                | pane > /pipeline <id> opens a task; Advance moves it on      | detail > Advance moves on with one click                     |
| Complete with a result                                                 | pane > a task in its last stage completes with a result      | detail > Complete: typed into the form, sent by its button   |
| Send back: stage select + reason; the stage before by default; no note | pane > Send back asks…; detail > Send back without a note…   | detail > Send back: the form opens on a click…               |
| Fail with what went wrong (form button)                                | pane > Fail asks what went wrong…                            | detail > Fail and Cancel the same way                        |
| Cancel with a reason                                                   | pane > Cancel asks why and drops the task                    | detail > Fail and Cancel the same way                        |
| Delete: confirmation, Never mind, Delete                               | pane > Delete asks first…                                    | detail > Delete: Never mind keeps it, Delete in the box…     |
| Never mind on each form, ring back on its button                       | detail > Never mind closes each form…; pane > Fail asks…     | detail > Delete: Never mind keeps it… (confirmation)         |
| Empty result / error / reason refused, the form kept                   | detail > Complete, Fail and Cancel refuse to go without them | n/a                                                          |
| A related task opens, `‹ #N` goes back                                 | detail > blocker → its subtask → back…                       | detail > a related task opens on a click, and ‹ back returns |
| Focus after every action (next step, form field, way out)              | every test above asserts it (`landsOn`)                      |                                                              |

## Stage gates

| What                                                                                                                                         | Covered by                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| require_artifact: said up front with who gives it; no Advance or Complete until met                                                          | detail > an artifact is required: said up front, no Advance or Complete until one is there; plugin > a stage gate is said up front… |
| require_comment: said up front; the ring on Advance, never in the field (a next `/pipeline N` is no comment)                                 | detail > a comment is required: the ring stays off the field, so a next /pipeline is no comment                                     |
| require_comment: Advance refused, then the ring in the comment field; one sent lets it move on                                               | detail > a comment is required…                                                                                                     |
| A refusal the hint explains says only `✗ #N can't leave <stage> yet`                                                                         | detail > an artifact is required…; detail > a comment is required…; plugin > a refusal the gate hint explains…                      |
| Complete refused by a comment gate: its form stays with the typed result and the hint, ring in the comment field, then Complete goes through | detail > Complete refused for want of a comment keeps its form and words…; plugin > a refusal the gate hint explains…               |

## Artifacts and comments

| What                                                                      | Covered by                                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Unfold / fold, ring kept on the toggle, Markdown rendered                 | pane > a task in progress…; detail > the newest version of each…                        |
| Newest version only (`v3`), `in <stage>`                                  | detail > the newest version of each, in Markdown; a long one is cut at 4,000 characters |
| Cut at 4,000 characters, "… N more characters not shown", ↓ scrolls to it | detail > the newest version of each…                                                    |
| Send a comment, ring back in the field, `▸ n earlier` appears             | pane > a comment is sent from its field and kept as the person                          |
| Latest five, `▸ n earlier` / `▾ Only the latest`, a reply shown           | detail > the latest five, the earlier ones on demand, a reply among them                |
| Author = `AGENT_TASKS_USER` on screen and in REST                         | pane > a comment is sent…; detail > a comment from the pane carries the person’s name   |

## Other sessions, toasts, the server

| What                                                                                                     | Covered by                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Task deleted elsewhere while open: "! #N was deleted elsewhere", back on the board                       | detail > deleted elsewhere: the pane says so and goes back to the board                    |
| Moved elsewhere: a stale Advance refused, the detail catches up                                          | detail > moved on elsewhere: an Advance from before is refused, then the detail catches up |
| Comments and stage from elsewhere show without a key                                                     | detail > changed elsewhere: comments and stage show up without a key                       |
| No toast for the pane's own acts                                                                         | detail > what the pane does itself is not toasted                                          |
| Toast: failed and ready for review; none for a cancel                                                    | detail > a cancel elsewhere is quiet…; board > toasts…                                     |
| Status entry follows tasks made and finished elsewhere                                                   | detail > the status entry follows tasks made and finished elsewhere                        |
| REST takeover: the serving session exits, another takes the port, the pane carries on by itself          | resilience > the session serving REST exits…                                               |
| Server down and back up by itself (no key), `offline` entry, `/pipeline` while down, ring back on a task | resilience > the server goes away and comes back: down and up again without a key          |
| Down while a task is open: back up, the same task, its next step works                                   | resilience > down while a task is open: back up, the same task is shown again              |
| An agent-tasks 1.x on the port: says which, `old server` entry, then the current one                     | resilience > an agent-tasks from before the board holds the port…                          |
| Server down → Refresh, "still no board (time)"                                                           | pane > says so instead of showing a stale board, and Refresh brings it back                |

## The session's claims and the pipeline reminder

`session` = `session.e2e.test.ts` (`claude -p --plugin-dir`, the model makes the calls).

| What                                                                                                                                                              | Covered by                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A `task_stage` claim the model makes is held by the session (`claude:<session id>`)                                                                               | session > a claim the model makes is held by its session, and the session ending ends the holder |
| The session ending ends its holder; past the grace the task fails with the reason                                                                                 | session > a claim the model makes is held by its session…                                        |
| `enforcePipeline` on: a work prompt, no task held, the model reads the reminder                                                                                   | session > with enforcePipeline, a work prompt in a session holding no task carries the reminder  |
| `enforcePipeline` on, the session holds a task (claimed in a first turn, `--resume`d): no reminder; the resumed session holds it again                            | session > with enforcePipeline, a session that holds a task is not reminded…                     |
| The session is a holder from `session.start` to `session.end`, claim or not                                                                                       | session > without enforcePipeline…; idle > beats from its start…                                 |
| `TaskCreate` (the session's own list) puts nothing on the board                                                                                                   | session > the session's own task list (TaskCreate) stays its own                                 |
| A REST server that hangs: no hook waits past its timeout; a new conversation is reminded without the server                                                       | session > a REST server that hangs costs the session seconds…                                    |
| An interactive session idle past twice the grace keeps its claim (sweeps find it alive, it keeps beating); `/exit` ends its holder; past the grace the task fails | idle > beats from its start, holds the claim its model makes through minutes idle…               |
| `/clear` in an interactive session: its claim moves to the new session id, the old holder ends, the sweep past the grace fails nothing                            | clear > keeps its claims under the new session id…                                               |
| `enforcePipeline` off: nothing                                                                                                                                    | session > without enforcePipeline, the same prompt carries nothing                               |
| A claim through an MCP process is held by that process (`mcp:<id>`)                                                                                               | mcp > task_update: metadata and a blocks dependency; then a dependency refusal                   |

## Landing again after a poll, and after Advance

| What                                                                                                 | Covered by                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Ring on New task, a task made elsewhere: the ring goes to its row, never into Find; the hotkeys work | board > a task made elsewhere takes the ring to its row…                                                |
| The ring's Advance moved on elsewhere: the ring goes to ‹ Board                                      | detail > changed elsewhere: comments and stage show up without a key                                    |
| Local Advance: the ring on ‹ Board, a second Enter moves nothing                                     | pane > /pipeline <id> opens a task; Advance moves it on, once; detail > Advance moves on with one click |
| A fresh board starts on the first task in progress                                                   | pane > opens on the board…; board > the ring starts on the first task in progress…                      |
| Empty Done: its digit keeps the ring on Done                                                         | board > Done says nothing finished yet…                                                                 |

## Round 3: the ring under other sessions' changes, delete, typing at speed

| Behaviour                                                                                                                         | Test                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A Complete form closed by a move elsewhere: ring on Complete (never Advance), words kept, header the keys'                        | pane > a Complete form closed by a move elsewhere lands on Complete…                         |
| Done right after a task finished elsewhere: its newest row, tabs in sight (3 runs)                                                | pane > Done right after a task finished elsewhere…                                           |
| Delete of a parent with an open subtask: says which, only Keep it                                                                 | pane > Delete of a parent with work open below…; plugin > delete with an open subtask below… |
| Clear on New: ring on Clear, a digit then switches tabs, no task made                                                             | pane > Clear on New lands on Clear…                                                          |
| New fields, comment, Fail reason, Find typed at 25 ms a key: every key arrives                                                    | speed > New: every field…; a comment and a Fail reason…; Find at 25 ms…                      |
| A comment typed at 40 ms while others claim, comment, advance, attach: text whole, nothing at the prompt, the changes drawn after | speed > a comment typed at 40 ms while other sessions…                                       |

## Round 4: hurried keys, stale views, control characters

| Behaviour                                                                                                                            | Test                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Enter twice on a board row (5 places in the focus order, 10–80 ms) or a Done row, docked and inline: the task opens, nothing changes | keys > Enter twice on a row…                                                |
| Enter twice right after /pipeline, and repeated pairs: nothing changes                                                               | keys > right after /pipeline…; Back then Enter…                             |
| Send back then Enter twice (80, 150 ms): it asks for the stage, sends nothing                                                        | keys > Send back, then Enter twice…                                         |
| An Advance drawn before a move elsewhere is refused, never a skip                                                                    | keys > Advance drawn before a move elsewhere…; detail > moved on elsewhere… |
| Advance three times fast: moves once, no task_stage advice shown                                                                     | keys > Advance pressed three times fast…                                    |
| 3 twice 40 ms apart: the ring is in Title, nothing at the prompt                                                                     | keys > 3 twice 40 ms apart…                                                 |
| Colour codes and control characters in a title, description, comment and artifact: drawn clean, the pane keeps its keys              | ansi > the board draws the title…; the task draws its description…          |

## Other sessions under a held keyboard, and artifact tables

| What                                                                                                                         | Covered by                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A task claimed (leaves the stage) and one raised above the ring: no row moves under it, Enter opens the task it is on        | pane > a task claimed and one raised above the ring move no row under it…                            |
| An artifact attached elsewhere above the comment field: the ring stays in the field, the header says so, a key types into it | pane > an artifact attached elsewhere above the comment field…                                       |
| `r` keeps the ring where it was (r then Enter never advances)                                                                | pane > r refreshes and leaves the ring where it was…                                                 |
| A form whose task was finished elsewhere closes: "changed elsewhere … nothing was sent"                                      | pane > a form whose task was finished elsewhere closes…                                              |
| A comment sent: the ring on ‹ Board, not in the field                                                                        | pane > a comment is sent from its field…; detail > a comment from the pane carries the person’s name |
| Gate refusal: "add the comment below", the ring stays on the pressed button / the form                                       | detail > a comment is required…; detail > Complete refused for want of a comment…                    |
| A table artifact at 110 columns (one row a line) and 240 (a table); the name on one line                                     | pane > an artifact with a table in a narrow and a wide dock                                          |
| A claim made without a name is made as `claude-code@<project>`, held by the session                                          | session > a claim the model makes without naming itself…                                             |
