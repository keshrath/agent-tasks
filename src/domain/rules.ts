// =============================================================================
// agent-tasks — IDE rule generation
//
// Generates project-specific rule files for Cursor (.mdc) and Claude Code
// (CLAUDE.md snippets) that instruct agents to use the pipeline.
// =============================================================================

export function generateRules(
  format: 'mdc' | 'claude_md',
  stages: string[],
  project?: string,
): string {
  if (format === 'mdc') {
    return generateMdc(stages, project);
  }
  return generateClaudeMd(stages, project);
}

function generateMdc(stages: string[], project?: string): string {
  const projectLine = project ? `\nProject: ${project}` : '';
  return `---
description: Pipeline task management workflow for AI agents
alwaysApply: true
---

# Pipeline Workflow${projectLine}

## Task Lifecycle

Tasks flow through stages: ${stages.filter((s) => s !== 'cancelled').join(' → ')}

## Rules

1. **Always check for work first**: Call \`task_list(next: true)\` to find available tasks
2. **Claim before working**: Call \`task_stage(action: "claim")\` before starting implementation
3. **Advance through stages**: Use \`task_stage(action: "advance")\` — never skip stages
4. **Attach artifacts**: Use \`task_artifact(type: "general")\` at each stage (specs, plans, test results, review notes)
5. **Comment on decisions**: Use \`task_artifact(type: "comment")\` to record reasoning and tradeoffs
6. **Complete with results**: Use \`task_stage(action: "complete")\` with a summary of what was done
7. **Create subtasks**: Break large tasks into subtasks with \`task_create\` using \`parent_id\`

## Available Tools

- \`task_create\` — Create a task (title, description, priority, project, tags, parent_id)
- \`task_get\` — Get task details (use include for subtasks, artifacts, comments)
- \`task_list\` — List/search/pick-next tasks (filter by status, stage, project, assignee)
- \`task_update\` — Update metadata and dependencies
- \`task_delete\` — Delete a task (cascading)
- \`task_stage\` — Lifecycle transitions (claim, advance, regress, complete, fail, cancel)
- \`task_artifact\` — Attach artifacts and comments (general, decision, learning, comment)
- \`task_config\` — Pipeline config, session, cleanup, rules
`;
}

function generateClaudeMd(stages: string[], project?: string): string {
  const projectLine = project ? ` for project "${project}"` : '';
  return `## Pipeline Tasks${projectLine}

Tasks flow through: ${stages.filter((s) => s !== 'cancelled').join(' → ')}

### Workflow
1. Check \`task_list(next: true)\` for available work
2. \`task_stage(action: "claim")\` before starting
3. \`task_stage(action: "advance")\` through stages — attach artifacts at each stage
4. \`task_artifact(type: "comment")\` to record decisions
5. \`task_stage(action: "complete")\` with summary

### Key Tools
\`task_create\`, \`task_get\`, \`task_list\`, \`task_update\`, \`task_delete\`, \`task_stage\`, \`task_artifact\`, \`task_config\`
`;
}
