# /pipeline pane: e2e coverage in the real Claude Code CLI

Every control, key, command form, view state, notice, toast and output a person can reach, and the test that drives it in the real CLI (`npm run e2e:claude`). `pane` = `pane.e2e.test.ts`, `board` = `board.e2e.test.ts`, `detail` = `detail.e2e.test.ts`; the test is named after the `>`. Layouts: **F** fullscreen dock at 160 columns, **N** the narrow dock at 110, **I** inline at 120.

## Command forms

| What                                                    | Covered by                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/pipeline`: answers with the board summary, opens pane | board > /pipeline answers with the board summary and opens the pane; pane > opens on the board by stage  |
| `/pipeline <id>` and `/pipeline #<id>`                  | pane > /pipeline <id> opens a task; Advance moves it on (`#id`); pane > a task in its last stage… (`id`) |
| `/pipeline <unknown id>`: says so, shows the board      | board > /pipeline <unknown id> says there is no such task and shows the board                            |
| `/pipeline <text>`: filters, answers with the count     | pane > Find narrows the board…; pane > /pipeline <text> lands on the first match every time              |
| `/pipeline <text>` matching nothing                     | board > /pipeline <text> that matches nothing lands on Clear the filter                                  |
| `/pipeline` while the pane is open                      | pane > /pipeline <text> lands on the first match every time (12 times, the pane open and polling)        |
| `/pipeline` after the pane was closed                   | board > the ✕ closes the pane; /pipeline opens it again on the board                                     |
| `/pipeline <id>` drops the text the last find kept      | pane > Find narrows the board by text, a project name too                                                |
| `/pipeline` while the server is down                    | resilience > the server goes away and comes back: down and up again without a key                        |

## Board

| What                                                                                                                            | Covered by                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Summary line (open, in progress, blocked)                                                                                       | pane > opens on the board by stage                                                                                |
| Stage counts, in pipeline order                                                                                                 | board > /pipeline answers with the board summary…; board > a project with its own stages…                         |
| Sections by stage; in progress first, then priority, then oldest                                                                | board > /pipeline answers with the board summary and opens the pane                                               |
| Row marks: ● in progress, ○ pending, ! blocked                                                                                  | pane > opens on the board by stage                                                                                |
| Row facts: waits for, assignee/unclaimed, subtasks, part of, project                                                            | pane > opens on the board by stage                                                                                |
| Priority marks: p5+ coloured, lower dim, none for p0                                                                            | board > priority marks…                                                                                           |
| Custom per-project pipeline: sections after the default stages                                                                  | board > a project with its own stages gets sections after the default ones                                        |
| Custom pipeline in a task's stage strip                                                                                         | board > a project with its own stages… (opens the proof task)                                                     |
| Long title: cut on one line, priority beside it                                                                                 | board > a long title is cut on its one line (F); board > board rows stay two lines (N)                            |
| Wide (CJK, emoji) title on one line                                                                                             | board > a title with wide characters stays on one line (F); board > board rows stay… (N)                          |
| A long board (62 tasks): Tab scrolls the pane with the ring                                                                     | board > a project with its own stages… (Tab to the last section)                                                  |
| ↑ ↓ scroll the pane, the ring stays                                                                                             | board > ↑ and ↓ scroll the board without moving the ring                                                          |
| A long backlog folds past 10 rows (`▸ N more`), unfolds (toggle stays after row 10, ring on the first row shown) and folds back | board > the long backlog folds past ten rows; Enter unfolds it and folds it again; plugin > a long backlog folds… |
| Empty board: says so, New task button, its landing                                                                              | board > says nothing is open and offers a new task                                                                |
| Empty board with recent work points at Done                                                                                     | board > once all is finished the board points at Done                                                             |
| Finished tasks are not on the board                                                                                             | pane > opens on the board by stage                                                                                |

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

| What                                                        | Covered by                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| Enter walks Title → Project → Priority → Tags → Description | pane > New: Enter walks the fields and the last one creates the task   |
| Priority not a whole number: said beneath, ring kept        | pane > New: Enter walks the fields…                                    |
| Created: `✓ created #N` on one line, the task opens         | pane > New: Enter walks the fields…; board > New from the empty board… |
| REST state: title, project, priority, tags, created_by      | pane > New: Enter walks the fields…; board > the mouse… (created_by)   |
| Create button                                               | board > New from the empty board creates the first task                |
| Clear button                                                | board > New: Clear empties what was typed and starts over in Title (N) |
| Field hints fit beside their labels                         | board > New: every field hint fits beside its label (N)                |
| Inline                                                      | board > Done and New draw inline too                                   |

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

| View  | F                                   | N                                                                | I                                                                              |
| ----- | ----------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Board | pane, board                         | pane > board, detail, forms…; board > board rows stay two lines… | pane > opens the board above the prompt; board > the board takes the keyboard… |
| Done  | pane > Done lists…                  | board > Done rows keep who…                                      | board > Done and New draw inline too                                           |
| New   | pane > New: Enter walks the fields… | board > New: every field hint fits…                              | board > Done and New draw inline too                                           |

## Detail

`resilience` = `resilience.e2e.test.ts`.

| What                                                                         | Covered by                                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Status line (mark, word, agent, priority, project), stage strip              | pane > a task in progress…; detail > an unclaimed subtask…; detail > a completed task…        |
| Created (by whom) / Updated, Tags                                            | detail > an unclaimed subtask…; pane > a task in progress…                                    |
| Result / Error / Reason fact                                                 | detail > a completed task…; pane > Done lists… (Error); detail > a cancelled task… (Reason)   |
| Cancelled: no stage strip                                                    | detail > a cancelled task: its reason, no stage strip                                         |
| Completed: only Delete, no Artifacts section                                 | detail > a completed task: its result, the strip at done, only Delete left                    |
| Unclaimed hint, no Advance/Complete/Fail/Send back, ring on `‹ Board`        | detail > an unclaimed subtask: its parent, who made it, no step to take, the way back         |
| Assigned pending: "Waiting for <agent> to start it."                         | detail > an assigned task waits for its agent                                                 |
| Custom pipeline: strip and `Advance ›` name its stages; Complete at the last | detail > a project with its own pipeline: the strip and Advance name its stages               |
| Blocked: no Advance/Complete, "It moves on once…", ring on the blocker       | pane > a blocked task cannot move on…; detail > blocker → its subtask → back…                 |
| Related / Duplicate links shown, never blocking                              | detail > a related link does not block: Advance stays; detail > a cancelled task… (Duplicate) |
| Part of (parent), Subtasks n/m done                                          | detail > an unclaimed subtask…; detail > blocker → its subtask → back…                        |
| Related-task navigation and the back trail (`‹ #N` … `‹ Board`)              | detail > blocker → its subtask → back, back, back to the board                                |
| Description fold (`▸ Show all N lines` / `▾ Show less`), ring kept           | pane > a task in progress…                                                                    |

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

| What                                                                                                                                         | Covered by                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| require_artifact: said up front with who gives it; no primary; Advance refused until met                                                     | detail > an artifact is required: said up front, Advance refused until one is there; plugin > a stage gate is said up front… |
| require_comment: said up front; the ring on Advance, never in the field (a next `/pipeline N` is no comment)                                 | detail > a comment is required: the ring stays off the field, so a next /pipeline is no comment                              |
| require_comment: Advance refused, then the ring in the comment field; one sent lets it move on                                               | detail > a comment is required…                                                                                              |
| A refusal the hint explains says only `✗ #N can't leave <stage> yet`                                                                         | detail > an artifact is required…; detail > a comment is required…; plugin > a refusal the gate hint explains…               |
| Complete refused by a comment gate: its form stays with the typed result and the hint, ring in the comment field, then Complete goes through | detail > Complete refused for want of a comment keeps its form and words…; plugin > a refusal the gate hint explains…        |

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
| Task deleted elsewhere while open: "✗ there is no task #N", back on the board                            | detail > deleted elsewhere: the pane says so and goes back to the board                    |
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
