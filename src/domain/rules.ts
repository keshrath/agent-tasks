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

1. **Always check for work first**: Call \`task_next\` to find available tasks
2. **Claim before working**: Call \`task_claim\` before starting implementation
3. **Advance through stages**: Use \`task_advance\` — never skip stages
4. **Attach artifacts**: Use \`task_add_artifact\` at each stage (specs, plans, test results, review notes)
5. **Comment on decisions**: Use \`task_comment\` to record reasoning and tradeoffs
6. **Complete with results**: Use \`task_complete\` with a summary of what was done
7. **Create subtasks**: Break large tasks into subtasks with \`task_create\` using \`parent_id\`

## Available Tools

- \`task_create\` — Create a task (title, description, priority, project, tags, parent_id)
- \`task_list\` — List tasks (filter by status, stage, project, assignee)
- \`task_claim\` — Claim and start working on a task
- \`task_advance\` — Move to next stage (checks dependencies)
- \`task_complete\` — Mark done with result
- \`task_add_artifact\` — Attach spec/plan/test results/review notes
- \`task_comment\` — Add discussion comment
- \`task_search\` — Full-text search across tasks
- \`task_next\` — Get highest-priority unblocked task
- \`task_review_cycle\` — Approve or reject during review
`;
}

function generateClaudeMd(stages: string[], project?: string): string {
  const projectLine = project ? ` for project "${project}"` : '';
  return `## Pipeline Tasks${projectLine}

Tasks flow through: ${stages.filter((s) => s !== 'cancelled').join(' → ')}

### Workflow
1. Check \`task_next\` for available work
2. \`task_claim\` before starting
3. \`task_advance\` through stages — attach artifacts at each stage
4. \`task_comment\` to record decisions
5. \`task_complete\` with summary

### Key Tools
\`task_create\`, \`task_list\`, \`task_claim\`, \`task_advance\`, \`task_complete\`, \`task_add_artifact\`, \`task_comment\`, \`task_search\`, \`task_next\`, \`task_review_cycle\`
`;
}
