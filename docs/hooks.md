# Hooks (Claude Code)

agent-tasks ships five hook scripts that integrate with Claude Code's
lifecycle events. They live under `scripts/hooks/` and are installed by
`scripts/setup.js` into `~/.claude/settings.json`.

All hooks fail open — any internal error is logged to stderr and the hook
returns an empty JSON object so the user is never blocked by a broken hook.

| Script                  | Event                  | Purpose                                          |
| ----------------------- | ---------------------- | ------------------------------------------------ |
| `session-start.js`      | SessionStart           | Announces the pipeline dashboard URL             |
| `task-cleanup-start.js` | SessionStart           | Auto-fails tasks assigned to dead sessions       |
| `pipeline-enforcer.mjs` | UserPromptSubmit       | Requires an active pipeline task for real work   |
| `todowrite-bridge.mjs`  | PreToolUse (TodoWrite) | Mirrors TodoWrite todos into the pipeline        |
| `task-cleanup-stop.js`  | Stop / SubagentStop    | Fails still-assigned tasks when the session ends |

## session-start.js

Prints the dashboard URL (`http://localhost:3422` by default, override via
`AGENT_TASKS_PORT`) and injects it as session context.

## task-cleanup-start.js

On every session start, opens the agent-tasks DB and finds tasks with
`status IN ('pending', 'in_progress')` whose `assigned_to` is not an online
agent in agent-comm. Those tasks are auto-failed with a `stale task cleanup`
message. Catches tasks orphaned by crashes where the Stop hook never fired.

## pipeline-enforcer.mjs

Runs on every `UserPromptSubmit`. Classifies the prompt as "work" or "not
work" (greetings, questions, slash commands, meta commands, and
system-injected blocks are all skipped). When the prompt looks like real
work, checks:

1. Is there a registered agent-comm identity for this session?
2. Does that identity have at least one task in `pending` or `in_progress`?

If either check fails, it injects a `PIPELINE REQUIRED` reminder into the
prompt context. **It never blocks** — the hook emits context, not a
permission decision, so Claude can still see the user's prompt and respond.

### Environment variables

| Variable         | Default                         | Description             |
| ---------------- | ------------------------------- | ----------------------- |
| `AGENT_COMM_DB`  | `~/.agent-comm/agent-comm.db`   | agent-comm SQLite path  |
| `AGENT_TASKS_DB` | `~/.agent-tasks/agent-tasks.db` | agent-tasks SQLite path |

### Work classification

The enforcer treats a prompt as "not work" when any of these match:

- Empty or < 15 characters
- Starts with a `<system-reminder>`, `<task-notification>`,
  `<local-command-caveat>`, `<command-name>`, or `<command-message>` tag
- Starts with a greeting (`hi`, `ok`, `yes`, ...)
- Starts with `/` (slash command) or a meta word (`commit`, `push`,
  `remember`, `save`, ...)
- Is a question under 200 characters

Anything else is treated as work.

## todowrite-bridge.mjs

Intercepts Claude Code's `TodoWrite` tool. For every non-completed todo in
the payload, POSTs a task to `http://localhost:3422/api/tasks` (override
with `AGENT_TASKS_URL`). Priority maps: `high → 5`, `medium → 3`, `low → 1`.
Tags each mirrored task with `synced,todowrite` and project `claude-todos`.

If agent-tasks isn't running, the hook silently fails after a 3 second
timeout and lets the original `TodoWrite` proceed.

## task-cleanup-stop.js

On `Stop` / `SubagentStop`, finds any tasks still assigned to this session
and fails them with a `session ended` message. Works together with
`task-cleanup-start.js` so crashes don't leak in-progress tasks forever.

## Manual configuration

`scripts/setup.js` writes the hooks into `~/.claude/settings.json`
automatically. If you need to configure them by hand, add entries like:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/abs/path/to/agent-tasks/scripts/hooks/session-start.js\"",
            "timeout": 5
          },
          {
            "type": "command",
            "command": "node \"/abs/path/to/agent-tasks/scripts/hooks/task-cleanup-start.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/abs/path/to/agent-tasks/scripts/hooks/pipeline-enforcer.mjs\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "TodoWrite",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/abs/path/to/agent-tasks/scripts/hooks/todowrite-bridge.mjs\"",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/abs/path/to/agent-tasks/scripts/hooks/task-cleanup-stop.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Replace `/abs/path/to/agent-tasks` with your clone path.

## Testing the hooks

`tests/hooks/hooks.test.ts` covers all five scripts with shape-correct
fail-open assertions. Run `npm test -- tests/hooks/` to execute them in
isolation.
