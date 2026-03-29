// =============================================================================
// agent-tasks — MCP transport
//
// Maps MCP tool calls to the TaskService. Thin adapter — validation lives
// in the domain layer, not here.
// =============================================================================

import type { AppContext } from '../context.js';
import type { ToolDefinition } from '../types.js';
import { ValidationError } from '../types.js';
import { handlers, type SessionState } from './mcp-handlers.js';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const tools: ToolDefinition[] = [
  {
    name: 'task_create',
    description: 'Create a pipeline task with optional stage, priority, and project.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title (max 500 chars)' },
        description: { type: 'string', description: 'Detailed instructions (max 50K chars)' },
        assign_to: { type: 'string', description: 'Agent name to assign to' },
        stage: { type: 'string', description: 'Pipeline stage (default: backlog)' },
        priority: {
          type: 'number',
          description: 'Priority (higher = more important, default: 0)',
        },
        project: { type: 'string', description: 'Project name for grouping' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        parent_id: { type: 'number', description: 'Parent task ID (creates a subtask)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'task_list',
    description: 'List tasks with optional filters and pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled'],
          description: 'Filter by status',
        },
        assign_to: { type: 'string', description: 'Filter by assigned agent name' },
        stage: { type: 'string', description: 'Filter by pipeline stage' },
        project: { type: 'string', description: 'Filter by project' },
        collaborator: { type: 'string', description: 'Filter tasks where agent is a collaborator' },
        root_only: { type: 'boolean', description: 'Only show top-level tasks (no subtasks)' },
        parent_id: { type: 'number', description: 'Filter subtasks of a specific parent' },
        limit: { type: 'number', description: 'Max results (default/max: 500)' },
        offset: { type: 'number', description: 'Skip first N results (for pagination)' },
      },
    },
  },
  {
    name: 'task_claim',
    description: 'Claim a pending task. Assigns it and advances from backlog to the next stage.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID to claim' },
        claimer: {
          type: 'string',
          description: 'Agent name claiming (uses session name if omitted)',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_update',
    description: 'Update task metadata (title, description, priority, tags, assignment).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        priority: { type: 'number', description: 'New priority' },
        project: { type: 'string', description: 'New project' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags' },
        assign_to: {
          type: 'string',
          description: 'New assignee (empty string to unassign)',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_next',
    description:
      "Get the highest-priority unassigned task with all dependencies met. When agent is provided, uses affinity scoring to prefer tasks related to the agent's previous work (tie-breaker among same-priority tasks). Returns null if none.",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter by project' },
        stage: { type: 'string', description: 'Filter by stage' },
        agent: {
          type: 'string',
          description:
            'Agent name for affinity scoring — prefers tasks where the agent worked on the parent, a dependency, or the same project',
        },
      },
    },
  },
  {
    name: 'task_delete',
    description: 'Delete a task and all its artifacts and dependencies (cascading delete).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID to delete' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_search',
    description: 'Full-text search across task titles and descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        project: { type: 'string', description: 'Filter by project' },
        limit: { type: 'number', description: 'Max results (default: 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'task_expand',
    description:
      'Break a task into subtasks. Creates subtasks with parent_id pointing to the given task, inheriting project and priority.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Parent task ID to expand' },
        subtasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Subtask title' },
              description: { type: 'string', description: 'Subtask description' },
              priority: {
                type: 'number',
                description: 'Priority override (inherits from parent if omitted)',
              },
            },
            required: ['title'],
          },
          description: 'Array of subtasks to create',
        },
      },
      required: ['task_id', 'subtasks'],
    },
  },
  {
    name: 'task_comment',
    description: 'Add a comment to a task for async discussion between agents.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        content: { type: 'string', description: 'Comment text' },
        parent_comment_id: { type: 'number', description: 'Reply to this comment (threading)' },
      },
      required: ['task_id', 'content'],
    },
  },
  {
    name: 'task_stage',
    description:
      'Manage task lifecycle stage transitions. Actions: "advance" moves to the next (or a specific) stage, "regress" sends back to an earlier stage, "complete" marks done, "fail" marks failed, "cancel" cancels.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['advance', 'regress', 'complete', 'fail', 'cancel'],
          description: 'Lifecycle action to perform',
        },
        task_id: { type: 'number', description: 'Task ID' },
        stage: {
          type: 'string',
          description:
            'Target stage (advance: optional, advances to next if omitted; regress: required)',
        },
        comment: {
          type: 'string',
          description:
            'Comment (advance: optional, also satisfies stage-gate require_comment check)',
        },
        reason: {
          type: 'string',
          description: 'Reason for regression, failure, or cancellation',
        },
        result: {
          type: 'string',
          description: 'Result summary (complete) or error description (fail)',
        },
      },
      required: ['action', 'task_id'],
    },
  },
  {
    name: 'task_query',
    description:
      'Query task-related data. Types: "subtasks" gets child tasks, "artifacts" gets attached documents, "comments" gets discussion threads.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['subtasks', 'artifacts', 'comments'],
          description: 'What to query',
        },
        task_id: { type: 'number', description: 'Task ID' },
        stage: {
          type: 'string',
          description: 'Filter artifacts by stage (only used with type: "artifacts")',
        },
        limit: {
          type: 'number',
          description: 'Max comments to return (only used with type: "comments", default: 100)',
        },
      },
      required: ['type', 'task_id'],
    },
  },
  {
    name: 'task_artifact',
    description:
      'Create task artifacts. Types: "general" attaches a document, "decision" records a structured decision (chose/over/because), "learning" captures an insight (auto-propagated on completion).',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['general', 'decision', 'learning'],
          description: 'Artifact type',
        },
        task_id: { type: 'number', description: 'Task ID' },
        name: {
          type: 'string',
          description:
            'Artifact name (type: "general" only, e.g. "spec", "test-results", "review-notes")',
        },
        content: {
          type: 'string',
          description:
            'Artifact content (type: "general": text/markdown/JSON, max 100K; type: "learning": the insight)',
        },
        stage: {
          type: 'string',
          description: 'Stage to attach to (type: "general" only, defaults to current stage)',
        },
        chose: { type: 'string', description: 'What was chosen (type: "decision" only)' },
        over: {
          type: 'string',
          description: 'What alternatives were considered (type: "decision" only)',
        },
        because: {
          type: 'string',
          description: 'Rationale for the decision (type: "decision" only)',
        },
        category: {
          type: 'string',
          enum: ['technique', 'pitfall', 'decision', 'pattern'],
          description: 'Learning category (type: "learning" only, default: technique)',
        },
      },
      required: ['type', 'task_id'],
    },
  },
  {
    name: 'task_config',
    description:
      'Configuration and utility operations. Actions: "pipeline" gets/sets pipeline stages and gate config, "session" sets session identity, "cleanup" runs data cleanup, "rules" generates IDE rule files.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['pipeline', 'session', 'cleanup', 'rules'],
          description: 'Config action to perform',
        },
        project: {
          type: 'string',
          description: 'Project name (pipeline: scope, rules: project-specific rules)',
        },
        stages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Stage names in order (pipeline set mode)',
        },
        gate_config: {
          type: 'object',
          description:
            'Stage-gate enforcement config (pipeline only). Example: { "require_comment": true, "require_artifact": false, "exempt_stages": ["backlog"] }',
          properties: {
            require_comment: {
              type: 'boolean',
              description: 'Require at least one comment before advancing (default: false)',
            },
            require_artifact: {
              type: 'boolean',
              description:
                'Require at least one artifact at current stage before advancing (default: false)',
            },
            exempt_stages: {
              type: 'array',
              items: { type: 'string' },
              description: 'Stages exempt from gate checks (e.g. ["backlog"])',
            },
            gates: {
              type: 'object',
              description:
                'Per-stage gate rules. Keys are stage names, values are StageGate objects with: require_artifacts (string[]), require_min_artifacts (number), require_comment (boolean), require_approval (boolean)',
              additionalProperties: {
                type: 'object',
                properties: {
                  require_artifacts: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Named artifacts that must exist at the stage before advancing',
                  },
                  require_min_artifacts: {
                    type: 'number',
                    description: 'Minimum number of artifacts required at the stage',
                  },
                  require_comment: {
                    type: 'boolean',
                    description: 'Require at least one comment before advancing from this stage',
                  },
                  require_approval: {
                    type: 'boolean',
                    description: 'Require an approved approval before advancing from this stage',
                  },
                },
              },
            },
          },
        },
        id: { type: 'string', description: 'Session ID (session only)' },
        name: { type: 'string', description: 'Session name (session only)' },
        mode: {
          type: 'string',
          enum: ['retention', 'stale_agents', 'all'],
          description: 'Cleanup mode (cleanup only, default: retention)',
        },
        timeout_minutes: {
          type: 'number',
          description:
            'Heartbeat timeout in minutes for stale agent detection (cleanup only, default: 30)',
        },
        format: {
          type: 'string',
          enum: ['mdc', 'claude_md'],
          description: 'Output format for rules: mdc (Cursor) or claude_md (Claude Code)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'task_dependency',
    description:
      'Manage task dependencies. "add" creates a relationship (blocks/related/duplicate). "remove" deletes one.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove'],
          description: 'Action to perform',
        },
        task_id: { type: 'number', description: 'Task that depends on another' },
        depends_on: {
          type: 'number',
          description: 'Task that must complete first (for blocks) or related task',
        },
        relationship: {
          type: 'string',
          enum: ['blocks', 'related', 'duplicate'],
          description: 'Relationship type (default: blocks, only used with "add")',
        },
      },
      required: ['action', 'task_id', 'depends_on'],
    },
  },
  {
    name: 'task_collaborator',
    description:
      'Manage task collaborators. "add" assigns an agent with a role (collaborator, reviewer, watcher). "remove" unassigns one.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove'],
          description: 'Action to perform',
        },
        task_id: { type: 'number', description: 'Task ID' },
        agent_id: { type: 'string', description: 'Agent name or ID' },
        role: {
          type: 'string',
          enum: ['collaborator', 'reviewer', 'watcher'],
          description: 'Role (default: collaborator, only used with "add")',
        },
      },
      required: ['action', 'task_id', 'agent_id'],
    },
  },
  {
    name: 'task_approval',
    description:
      'Manage approval workflows. Actions: "request" creates an approval request, "approve" approves one, "reject" rejects one, "list" lists pending approvals, "review" is a convenience approve/reject that also advances or regresses the task.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['request', 'approve', 'reject', 'list', 'review'],
          description: 'Action to perform',
        },
        task_id: {
          type: 'number',
          description: 'Task ID (required for request and review)',
        },
        approval_id: {
          type: 'number',
          description: 'Approval ID (required for approve and reject)',
        },
        stage: {
          type: 'string',
          description: 'Stage requiring approval (request only, defaults to current)',
        },
        reviewer: {
          type: 'string',
          description: 'Reviewer to assign (request) or filter by (list)',
        },
        comment: {
          type: 'string',
          description: 'Comment (optional for approve, required for reject)',
        },
        decision: {
          type: 'string',
          enum: ['approve', 'reject'],
          description: 'Decision for review action',
        },
        reason: {
          type: 'string',
          description: 'Rejection reason (required for review+reject)',
        },
        regress_to: {
          type: 'string',
          description: 'Stage to regress to on rejection (reject/review, default: implement)',
        },
      },
      required: ['action'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export type ToolHandler = (
  name: string,
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;

export function createToolHandler(ctx: AppContext): ToolHandler {
  const session: SessionState = { current: null };

  return function handleTool(
    name: string,
    args: Record<string, unknown>,
  ): unknown | Promise<unknown> {
    const handler = handlers[name];
    if (!handler) throw new ValidationError(`Unknown tool: ${name}`);
    return handler(ctx, args, session);
  };
}
