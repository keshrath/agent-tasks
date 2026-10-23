#!/usr/bin/env node

// =============================================================================
// agent-tasks SessionStart hook
//
// Tells the person and the model where the pipeline lives: the MCP tools for
// the model, the /pipeline pane (agent-tasks plugin) for the person.
// =============================================================================

const msg = {
  systemMessage: 'agent-tasks: with the agent-tasks plugin, /pipeline opens the board',
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext:
      'Pipeline: agent-tasks MCP tools (task_list, task_stage, task_artifact). With the agent-tasks plugin installed, the person follows the board in the /pipeline pane.',
  },
};

console.log(JSON.stringify(msg));
