# The plugin's session hooks (Claude Code)

agent-tasks 3.0 has no command hooks and nothing to write into `settings.json`. The
agent-tasks plugin's mod (`plugin/hooks/register.tsx`, Claude Code 2.1.289+) hooks the
session itself, next to the `/pipeline` pane. Every hook fails open: a server that is
away never blocks a prompt, a tool call or the end of a session, and every request the
plugin makes gives up after 3 s, so a server that hangs costs at most that.

| Hook             | What it does                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.start`  | Registers `/pipeline`, polls the board, and makes the session a claim holder (`claude:<session id>`)                                                             |
| clock, every 30s | The session's holder beats, idle or not                                                                                                                          |
| `tool.call`      | After a `task_stage` claim or assign that succeeded, the session adopts the task (`POST /api/holders/:holder`)                                                   |
| `session.end`    | Ends the session's holder (`DELETE /api/holders/:holder`); its open tasks fail once the grace has passed                                                         |
| `prompt.submit`  | With `enforcePipeline` on: a work prompt in a session that holds no open task carries a reminder to claim one                                                    |
| `prompt.context` | Once per conversation: what is in flight across every session, this session's own claims first and marked; it asks to claim first only with `enforcePipeline` on |

## Claimed tasks live with their session

A task in progress is failed for the session working on it being gone, never for its agent
being quiet. The server keeps claim holders (`src/domain/holders.ts`): each MCP process holds
the tasks claimed or moved on (advanced) through it and beats every 30 seconds while it runs;
the plugin moves the tasks its agents claim or move on to the session itself, so they also
survive an MCP server reconnecting, and carries them across a `/clear` (which ends the
conversation, not its work: the next beat moves them to the new session id). A holder that
ended, or stopped beating, longer than `AGENT_TASKS_DEAD_SESSION_GRACE_MINUTES` (default 10)
ago is gone, and every agent-tasks process that sweeps fails the tasks in progress it held:

- `The session holding this task ended without completing it (<assignee>).`
- `The session holding this task stopped answering (<assignee>).`

A holder that beats again within the grace (a resumed session) keeps its tasks. A process's
first tick after starting, and its first tick after the machine slept, beat without sweeping,
and the plugin beats at once on a tick that comes late, so no session is judged while the
others have not had a chance to beat. Only work in progress is held: a task sent back to a
queue stage, or one nothing holds (claimed over REST, before 3.0), is never failed this way.

The session that moves a task on holds it from then on: a task assigned to another agent is
held by whoever advances it. Without the plugin, an MCP process that restarted mid-session
takes back its agent's tasks nothing alive holds when the agent names itself again
(`task_config` action `session`; the answer lists them as `reclaimed`).

## The pipeline reminder

Off unless the plugin's `enforcePipeline` option is on. It looks only at prompts the person
sent (typed, Remote Control, `claude -p`), never at a slash command, a notification or a peer's
message, and only at prompts that ask for work (`plugin/hooks/work.ts`, read sentence by
sentence, words like `ok`, `yes,`, `please`, `go ahead and` in front read past): a sentence
that starts with something to do (`add`, `fix`, `implement`, `push the notes into…`, a go-ahead
like `continue`), a request (`can you add…`, `could you fix…`), or any other statement of 20
characters or more (`Status page needs a dark mode toggle, build it`). Not work: a question
asking to know (`How does…?`, `What's the status of #12?`), a thanks (`looks great`), a git
command alone (`commit and push`), a note to remember, a slash command; nor what is answered
in the chat (`write a haiku`, `translate this sentence`, `give me a list of…`, `run the tests`).
Asked to know and then to do (`explain why it fails and then fix it`) is work. A prompt of 200
characters or more is work whatever its form. When this session holds no open task, the
model reads, beside the prompt:

> PIPELINE REQUIRED: this session holds no claimed agent-tasks task.
>
> Before doing this work, create a task with task_create or claim one with task_stage action
> "claim". Do NOT start writing code or making changes until this session has claimed a
> pipeline task.

It never blocks the prompt, and asks the server nothing for it: what the session holds is
known from its beats, and a new conversation (nothing said in it yet, nothing carried over
from a `/clear`) holds nothing. Only a resumed conversation's first prompt, before its first
beat answered, waits for that beat (at most 3 s); no answer lets the prompt through without
the reminder.

## Upgrading from 2.x

Remove the agent-tasks entries from `~/.claude/settings.json` (`session-start.js`,
`task-cleanup-start.js`, `pipeline-enforcer.mjs`, `todowrite-bridge.mjs`,
`task-cleanup-stop.js`): the scripts are gone. What they did:

- `session-start.js`: the `prompt.context` block says the same, with what is in flight.
- `task-cleanup-start.js`, `task-cleanup-stop.js`: replaced by claim holders. They failed
  tasks whose assignee agent-comm did not list as online, which failed the tasks of live
  sessions that were only idle (waiting on the person) and every task claimed without a name.
- `pipeline-enforcer.mjs`: the `prompt.submit` reminder, opt-in, and about this session's own
  claims (the script read whichever agent-comm agent had beaten last, any session's).
- `todowrite-bridge.mjs`: dropped. Claude Code has no `TodoWrite` tool any more, and its
  session task list is the session's own scratch, not pipeline work.
