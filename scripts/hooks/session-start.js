#!/usr/bin/env node

// =============================================================================
// agent-tasks SessionStart hook
//
// Announces the pipeline dashboard URL.
// =============================================================================

const tasksPort = process.env.AGENT_TASKS_PORT || '3422';

const msg = {
  systemMessage: `agent-tasks: http://localhost:${tasksPort}`,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: `Pipeline: http://localhost:${tasksPort}`,
  },
};

console.log(JSON.stringify(msg));
