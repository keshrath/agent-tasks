// =============================================================================
// agent-tasks — MCP transport
//
// Maps MCP tool calls to the TaskService. Thin adapter — validation lives
// in the domain layer, not here.
// =============================================================================

import type { AppContext } from '../context.js';
import type { TaskStatus, ToolDefinition } from '../types.js';
import { ValidationError } from '../types.js';

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
        assigned_to: { type: 'string', description: 'Filter by assigned agent name' },
        stage: { type: 'string', description: 'Filter by pipeline stage' },
        project: { type: 'string', description: 'Filter by project' },
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
    name: 'task_complete',
    description: 'Mark a task as completed with a result.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        result: { type: 'string', description: 'Result or output' },
      },
      required: ['task_id', 'result'],
    },
  },
  {
    name: 'task_fail',
    description: 'Mark a task as failed with an error message.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        result: { type: 'string', description: 'Error description' },
      },
      required: ['task_id', 'result'],
    },
  },
  {
    name: 'task_cancel',
    description: 'Cancel a task — moves it to the cancelled stage.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        reason: { type: 'string', description: 'Why the task was cancelled' },
      },
      required: ['task_id', 'reason'],
    },
  },
  {
    name: 'task_advance',
    description:
      'Advance a task to the next pipeline stage (or a specific stage). Validates dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        stage: { type: 'string', description: 'Target stage (omit to advance to next stage)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_regress',
    description: 'Send a task back to an earlier stage (e.g. review rejection).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        stage: { type: 'string', description: 'Target stage to regress to' },
        reason: {
          type: 'string',
          description: 'Reason for regression (stored as artifact)',
        },
      },
      required: ['task_id', 'stage'],
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
      'Get the highest-priority unassigned task with all dependencies met. Returns null if none.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter by project' },
        stage: { type: 'string', description: 'Filter by stage' },
      },
    },
  },
  {
    name: 'task_add_dependency',
    description: 'Make a task depend on another (blocks advancement until dependency is done).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task that depends on another' },
        depends_on: { type: 'number', description: 'Task that must complete first' },
      },
      required: ['task_id', 'depends_on'],
    },
  },
  {
    name: 'task_remove_dependency',
    description: 'Remove a dependency between tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        depends_on: { type: 'number', description: 'Dependency to remove' },
      },
      required: ['task_id', 'depends_on'],
    },
  },
  {
    name: 'task_add_artifact',
    description:
      'Attach a document/artifact to a task (spec, plan, test results, review notes, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        name: {
          type: 'string',
          description: 'Artifact name (e.g. "spec", "test-results", "review-notes")',
        },
        content: {
          type: 'string',
          description: 'Artifact content (text, markdown, JSON, max 100K)',
        },
        stage: {
          type: 'string',
          description: 'Stage to attach to (defaults to task current stage)',
        },
      },
      required: ['task_id', 'name', 'content'],
    },
  },
  {
    name: 'task_get_artifacts',
    description: 'Get artifacts attached to a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        stage: { type: 'string', description: 'Filter by stage' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_pipeline_config',
    description:
      'Get or set pipeline stages for a project. Call without stages to get current config.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name (omit for default pipeline)',
        },
        stages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Stage names in order (set mode)',
        },
      },
    },
  },
  {
    name: 'task_set_session',
    description:
      'Set the session identity for this connection (used to track who creates/claims tasks).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        name: { type: 'string', description: 'Session name' },
      },
      required: ['id', 'name'],
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
];

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string' || !val.trim()) {
    throw new ValidationError(`"${key}" must be a non-empty string.`);
  }
  return val;
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') throw new ValidationError(`"${key}" must be a string.`);
  return val;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const val = args[key];
  if (typeof val !== 'number') {
    throw new ValidationError(`"${key}" is required and must be a number.`);
  }
  return val;
}

function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number') throw new ValidationError(`"${key}" must be a number.`);
  return val;
}

function optStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
    throw new ValidationError(`"${key}" must be an array of strings.`);
  }
  return val as string[];
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export type ToolHandler = (name: string, args: Record<string, unknown>) => unknown;

export function createToolHandler(ctx: AppContext): ToolHandler {
  let currentSession: { id: string; name: string } | null = null;

  function sessionName(): string {
    return currentSession?.name ?? 'system';
  }

  return function handleTool(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case 'task_set_session': {
        const id = requireString(args, 'id');
        const sessionName = requireString(args, 'name');
        currentSession = { id, name: sessionName };
        return { success: true, id, name: sessionName };
      }

      case 'task_create': {
        return ctx.tasks.create(
          {
            title: requireString(args, 'title'),
            description: optString(args, 'description'),
            assign_to: optString(args, 'assign_to'),
            stage: optString(args, 'stage'),
            priority: optNumber(args, 'priority'),
            project: optString(args, 'project'),
            tags: optStringArray(args, 'tags'),
          },
          sessionName(),
        );
      }

      case 'task_list': {
        return ctx.tasks.list({
          status: optString(args, 'status') as TaskStatus | undefined,
          assigned_to: optString(args, 'assigned_to'),
          stage: optString(args, 'stage'),
          project: optString(args, 'project'),
          limit: optNumber(args, 'limit'),
          offset: optNumber(args, 'offset'),
        });
      }

      case 'task_claim': {
        const claimer = optString(args, 'claimer') ?? sessionName();
        return ctx.tasks.claim(requireNumber(args, 'task_id'), claimer);
      }

      case 'task_complete':
        return ctx.tasks.complete(requireNumber(args, 'task_id'), requireString(args, 'result'));

      case 'task_fail':
        return ctx.tasks.fail(requireNumber(args, 'task_id'), requireString(args, 'result'));

      case 'task_cancel':
        return ctx.tasks.cancel(requireNumber(args, 'task_id'), requireString(args, 'reason'));

      case 'task_advance':
        return ctx.tasks.advance(requireNumber(args, 'task_id'), optString(args, 'stage'));

      case 'task_regress':
        return ctx.tasks.regress(
          requireNumber(args, 'task_id'),
          requireString(args, 'stage'),
          optString(args, 'reason'),
        );

      case 'task_update':
        return ctx.tasks.update(requireNumber(args, 'task_id'), {
          title: optString(args, 'title'),
          description: optString(args, 'description'),
          priority: optNumber(args, 'priority'),
          project: optString(args, 'project'),
          tags: optStringArray(args, 'tags'),
          assigned_to: optString(args, 'assign_to'),
        });

      case 'task_next': {
        return (
          ctx.tasks.next(optString(args, 'project'), optString(args, 'stage')) ?? {
            message: 'No available tasks.',
          }
        );
      }

      case 'task_add_dependency': {
        ctx.tasks.addDependency(requireNumber(args, 'task_id'), requireNumber(args, 'depends_on'));
        return { success: true, task_id: args.task_id, depends_on: args.depends_on };
      }

      case 'task_remove_dependency': {
        ctx.tasks.removeDependency(
          requireNumber(args, 'task_id'),
          requireNumber(args, 'depends_on'),
        );
        return { success: true };
      }

      case 'task_add_artifact': {
        return ctx.tasks.addArtifact(
          requireNumber(args, 'task_id'),
          requireString(args, 'name'),
          requireString(args, 'content'),
          sessionName(),
          optString(args, 'stage'),
        );
      }

      case 'task_get_artifacts':
        return ctx.tasks.getArtifacts(requireNumber(args, 'task_id'), optString(args, 'stage'));

      case 'task_pipeline_config': {
        const stages = optStringArray(args, 'stages');
        if (stages) {
          return ctx.tasks.setPipelineConfig(optString(args, 'project') || 'default', stages);
        }
        return { stages: ctx.tasks.getPipelineStages(optString(args, 'project')) };
      }

      case 'task_delete': {
        ctx.tasks.delete(requireNumber(args, 'task_id'));
        return { success: true };
      }

      default:
        throw new ValidationError(`Unknown tool: ${name}`);
    }
  };
}
