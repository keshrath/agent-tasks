// =============================================================================
// agent-tasks — MCP transport
//
// Maps MCP tool calls to the TaskService. Thin adapter — validation lives
// in the domain layer, not here.
// =============================================================================

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AppContext } from '../context.js';
import type { CollaboratorRole, TaskStatus, ToolDefinition } from '../types.js';
import { ValidationError, type TaskRelationshipType } from '../types.js';
import { generateRules } from '../domain/rules.js';

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
        assigned_to: { type: 'string', description: 'Filter by assigned agent name' },
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
      'Advance a task to the next pipeline stage (or a specific stage). Validates dependencies and stage gates. Optionally attach a comment in the same call.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        stage: { type: 'string', description: 'Target stage (omit to advance to next stage)' },
        comment: {
          type: 'string',
          description:
            'Optional comment to attach (also satisfies stage-gate require_comment check)',
        },
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
    description:
      'Add a relationship between tasks. "blocks" prevents advancement until dependency is done. "related" and "duplicate" are informational only.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task that depends on another' },
        depends_on: {
          type: 'number',
          description: 'Task that must complete first (for blocks) or related task',
        },
        relationship: {
          type: 'string',
          enum: ['blocks', 'related', 'duplicate'],
          description: 'Relationship type (default: blocks)',
        },
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
      'Get or set pipeline stages and gate config for a project. Call without stages/gate_config to get current config.',
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
        gate_config: {
          type: 'object',
          description:
            'Stage-gate enforcement config. Example: { "require_comment": true, "require_artifact": false, "exempt_stages": ["backlog"] }',
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
    name: 'task_get_comments',
    description: 'Get comments on a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        limit: { type: 'number', description: 'Max comments (default: 100)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_add_collaborator',
    description: 'Add an agent as collaborator on a task (roles: collaborator, reviewer, watcher).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        agent_id: { type: 'string', description: 'Agent name or ID' },
        role: {
          type: 'string',
          enum: ['collaborator', 'reviewer', 'watcher'],
          description: 'Role (default: collaborator)',
        },
      },
      required: ['task_id', 'agent_id'],
    },
  },
  {
    name: 'task_remove_collaborator',
    description: 'Remove a collaborator from a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        agent_id: { type: 'string', description: 'Agent name or ID' },
      },
      required: ['task_id', 'agent_id'],
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
    name: 'task_get_subtasks',
    description: 'Get subtasks of a parent task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Parent task ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_request_approval',
    description: 'Request approval for a task at a specific stage.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID' },
        stage: { type: 'string', description: 'Stage requiring approval (defaults to current)' },
        reviewer: { type: 'string', description: 'Specific reviewer to assign' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_approve',
    description: 'Approve a pending approval request.',
    inputSchema: {
      type: 'object',
      properties: {
        approval_id: { type: 'number', description: 'Approval ID' },
        comment: { type: 'string', description: 'Approval comment' },
      },
      required: ['approval_id'],
    },
  },
  {
    name: 'task_reject',
    description: 'Reject a pending approval and optionally regress the task.',
    inputSchema: {
      type: 'object',
      properties: {
        approval_id: { type: 'number', description: 'Approval ID' },
        comment: { type: 'string', description: 'Rejection reason (required)' },
        regress_to: { type: 'string', description: 'Stage to regress task to' },
      },
      required: ['approval_id', 'comment'],
    },
  },
  {
    name: 'task_pending_approvals',
    description: 'List pending approval requests, optionally filtered by reviewer.',
    inputSchema: {
      type: 'object',
      properties: {
        reviewer: { type: 'string', description: 'Filter by reviewer' },
      },
    },
  },
  {
    name: 'task_review_cycle',
    description:
      'Review a task: approve (advance to next stage) or reject (regress with reason). Convenience wrapper for the maker-checker pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID to review' },
        action: {
          type: 'string',
          enum: ['approve', 'reject'],
          description: 'Approve or reject',
        },
        reason: { type: 'string', description: 'Rejection reason (required for reject)' },
        regress_to: {
          type: 'string',
          description: 'Stage to regress to on rejection (default: implement)',
        },
      },
      required: ['task_id', 'action'],
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
    name: 'task_cleanup',
    description:
      'Run data cleanup. Modes: "retention" (default) purges old completed/cancelled tasks, "stale_agents" checks agent heartbeats and fails tasks from dead agents, "all" runs both.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['retention', 'stale_agents', 'all'],
          description: 'Cleanup mode (default: retention)',
        },
        timeout_minutes: {
          type: 'number',
          description:
            'Heartbeat timeout in minutes for stale agent detection (default: 30, only used with stale_agents mode)',
        },
      },
    },
  },
  {
    name: 'task_generate_rules',
    description:
      'Generate IDE-specific rule files that instruct agents to use the pipeline. Supports Cursor (.mdc) and Claude Code (CLAUDE.md) formats.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['mdc', 'claude_md'],
          description: 'Output format: mdc (Cursor) or claude_md (Claude Code)',
        },
        project: { type: 'string', description: 'Project name for project-specific rules' },
      },
      required: ['format'],
    },
  },
  {
    name: 'task_decision',
    description:
      'Record an architectural or design decision as a structured artifact on a task. Stored at the current stage.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID to record the decision on' },
        chose: { type: 'string', description: 'What was chosen' },
        over: { type: 'string', description: 'What alternatives were considered' },
        because: { type: 'string', description: 'Rationale for the decision' },
      },
      required: ['task_id', 'chose', 'over', 'because'],
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

function optBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'boolean') throw new ValidationError(`"${key}" must be a boolean.`);
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

export type ToolHandler = (
  name: string,
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;

export function createToolHandler(ctx: AppContext): ToolHandler {
  let currentSession: { id: string; name: string } | null = null;

  function sessionName(): string {
    return currentSession?.name ?? 'system';
  }

  return function handleTool(
    name: string,
    args: Record<string, unknown>,
  ): unknown | Promise<unknown> {
    switch (name) {
      case 'task_set_session': {
        const id = requireString(args, 'id');
        const sName = requireString(args, 'name');
        currentSession = { id, name: sName };
        writeSessionFile(id, sName);
        return { success: true, id, name: sName };
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
            parent_id: optNumber(args, 'parent_id'),
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
          parent_id: optNumber(args, 'parent_id'),
          root_only: optBoolean(args, 'root_only'),
          collaborator: optString(args, 'collaborator'),
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

      case 'task_advance': {
        const advanceTaskId = requireNumber(args, 'task_id');
        const advanceComment = optString(args, 'comment');
        const advanced = ctx.tasks.advance(advanceTaskId, optString(args, 'stage'), advanceComment);
        if (advanceComment) {
          ctx.comments.add(advanceTaskId, sessionName(), advanceComment);
        }
        return advanced;
      }

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
        const relationship = (optString(args, 'relationship') ?? 'blocks') as TaskRelationshipType;
        ctx.tasks.addDependency(
          requireNumber(args, 'task_id'),
          requireNumber(args, 'depends_on'),
          relationship,
        );
        return { success: true, task_id: args.task_id, depends_on: args.depends_on, relationship };
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
        const gateConfig = args.gate_config as Record<string, unknown> | undefined;
        const project = optString(args, 'project') || 'default';
        if (stages) {
          ctx.tasks.setPipelineConfig(project, stages);
        }
        if (gateConfig && typeof gateConfig === 'object') {
          const parsedGates: Record<string, Record<string, unknown>> = {};
          if (gateConfig.gates && typeof gateConfig.gates === 'object') {
            for (const [stageName, stageRule] of Object.entries(
              gateConfig.gates as Record<string, Record<string, unknown>>,
            )) {
              parsedGates[stageName] = {
                require_artifacts: Array.isArray(stageRule.require_artifacts)
                  ? (stageRule.require_artifacts as string[])
                  : undefined,
                require_min_artifacts:
                  typeof stageRule.require_min_artifacts === 'number'
                    ? stageRule.require_min_artifacts
                    : undefined,
                require_comment: stageRule.require_comment === true ? true : undefined,
                require_approval: stageRule.require_approval === true ? true : undefined,
              };
            }
          }
          ctx.tasks.setGateConfig(project, {
            require_comment: gateConfig.require_comment === true,
            require_artifact: gateConfig.require_artifact === true,
            exempt_stages: Array.isArray(gateConfig.exempt_stages)
              ? (gateConfig.exempt_stages as string[])
              : undefined,
            gates: Object.keys(parsedGates).length > 0 ? parsedGates : undefined,
          });
        }
        if (stages || gateConfig) {
          const config = ctx.tasks.getGateConfig(project);
          return {
            stages: ctx.tasks.getPipelineStages(project),
            gate_config: config ?? { require_comment: false },
          };
        }
        return {
          stages: ctx.tasks.getPipelineStages(optString(args, 'project')),
          gate_config: ctx.tasks.getGateConfig(optString(args, 'project')) ?? {
            require_comment: false,
          },
        };
      }

      case 'task_delete': {
        ctx.tasks.delete(requireNumber(args, 'task_id'));
        return { success: true };
      }

      case 'task_comment': {
        return ctx.comments.add(
          requireNumber(args, 'task_id'),
          sessionName(),
          requireString(args, 'content'),
          optNumber(args, 'parent_comment_id'),
        );
      }

      case 'task_get_comments':
        return ctx.comments.list(requireNumber(args, 'task_id'), optNumber(args, 'limit'));

      case 'task_add_collaborator': {
        return ctx.collaborators.add(
          requireNumber(args, 'task_id'),
          requireString(args, 'agent_id'),
          (optString(args, 'role') ?? 'collaborator') as CollaboratorRole,
        );
      }

      case 'task_remove_collaborator': {
        ctx.collaborators.remove(requireNumber(args, 'task_id'), requireString(args, 'agent_id'));
        return { success: true };
      }

      case 'task_search':
        return ctx.tasks.search(requireString(args, 'query'), {
          project: optString(args, 'project'),
          limit: optNumber(args, 'limit'),
        });

      case 'task_get_subtasks':
        return ctx.tasks.getSubtasks(requireNumber(args, 'task_id'));

      case 'task_request_approval': {
        const taskId = requireNumber(args, 'task_id');
        const task = ctx.tasks.getById(taskId);
        if (!task) throw new ValidationError(`Task ${taskId} not found.`);
        const stage = optString(args, 'stage') ?? task.stage;
        return ctx.approvals.request(taskId, stage, optString(args, 'reviewer'));
      }

      case 'task_approve':
        return ctx.approvals.approve(
          requireNumber(args, 'approval_id'),
          sessionName(),
          optString(args, 'comment'),
        );

      case 'task_reject': {
        const approval = ctx.approvals.reject(
          requireNumber(args, 'approval_id'),
          sessionName(),
          requireString(args, 'comment'),
        );
        const regressTo = optString(args, 'regress_to');
        if (regressTo) {
          ctx.tasks.regress(approval.task_id, regressTo, requireString(args, 'comment'));
        }
        return approval;
      }

      case 'task_pending_approvals':
        return ctx.approvals.getPending(optString(args, 'reviewer'));

      case 'task_review_cycle': {
        const taskId = requireNumber(args, 'task_id');
        const action = requireString(args, 'action');
        const task = ctx.tasks.getById(taskId);
        if (!task) throw new ValidationError(`Task ${taskId} not found.`);

        if (action === 'approve') {
          ctx.tasks.advance(taskId);
          return { success: true, action: 'approved', task: ctx.tasks.getById(taskId) };
        } else if (action === 'reject') {
          const reason = requireString(args, 'reason');
          const regressTo = optString(args, 'regress_to') ?? 'implement';
          ctx.tasks.regress(taskId, regressTo, reason);
          return { success: true, action: 'rejected', task: ctx.tasks.getById(taskId) };
        } else {
          throw new ValidationError(`Invalid action: ${action}. Use "approve" or "reject".`);
        }
      }

      case 'task_expand': {
        const parentId = requireNumber(args, 'task_id');
        const parent = ctx.tasks.getById(parentId);
        if (!parent) throw new ValidationError(`Task ${parentId} not found.`);
        const subtaskDefs = args.subtasks;
        if (!Array.isArray(subtaskDefs) || subtaskDefs.length === 0) {
          throw new ValidationError('"subtasks" must be a non-empty array.');
        }
        const created = [];
        for (const sub of subtaskDefs) {
          if (
            typeof sub !== 'object' ||
            sub === null ||
            typeof (sub as Record<string, unknown>).title !== 'string'
          ) {
            throw new ValidationError('Each subtask must have a "title" string.');
          }
          const s = sub as Record<string, unknown>;
          created.push(
            ctx.tasks.create(
              {
                title: s.title as string,
                description: (s.description as string) ?? undefined,
                priority: typeof s.priority === 'number' ? s.priority : parent.priority,
                project: parent.project ?? undefined,
                parent_id: parentId,
              },
              sessionName(),
            ),
          );
        }
        return created;
      }

      case 'task_cleanup': {
        const cleanupMode = (optString(args, 'mode') ?? 'retention') as string;
        const timeoutMinutes = optNumber(args, 'timeout_minutes');
        if (cleanupMode === 'stale_agents') {
          return ctx.cleanup.failStaleAgentTasks(timeoutMinutes).then((stale) => ({
            stale_agents: stale,
          }));
        }
        if (cleanupMode === 'all') {
          const retention = ctx.cleanup.run();
          return ctx.cleanup.failStaleAgentTasks(timeoutMinutes).then((stale) => ({
            retention,
            stale_agents: stale,
          }));
        }
        return ctx.cleanup.run();
      }

      case 'task_generate_rules': {
        const format = requireString(args, 'format') as 'mdc' | 'claude_md';
        if (format !== 'mdc' && format !== 'claude_md') {
          throw new ValidationError('Format must be "mdc" or "claude_md".');
        }
        const project = optString(args, 'project');
        const stages = ctx.tasks.getPipelineStages(project);
        return { rules: generateRules(format, stages, project) };
      }

      case 'task_decision': {
        const taskId = requireNumber(args, 'task_id');
        const chose = requireString(args, 'chose');
        const over = requireString(args, 'over');
        const because = requireString(args, 'because');
        const task = ctx.tasks.getById(taskId);
        if (!task) throw new ValidationError(`Task ${taskId} not found.`);
        const decisionStage = task.stage;
        const decisionContent = [
          '## Decision',
          `**Chose:** ${chose}`,
          `**Over:** ${over}`,
          `**Because:** ${because}`,
          '',
          `_Recorded at stage: ${decisionStage}_`,
        ].join('\n');
        return ctx.tasks.addArtifact(taskId, decisionStage, 'decision', decisionContent);
      }

      default:
        throw new ValidationError(`Unknown tool: ${name}`);
    }
  };
}

function writeSessionFile(id: string, name: string): void {
  try {
    const claudeDir = join(homedir(), '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const filePath = join(claudeDir, `hub-session.${id}.json`);
    writeFileSync(
      filePath,
      JSON.stringify({ pid: process.pid, name, id, timestamp: new Date().toISOString() }),
    );
  } catch {
    /* non-critical */
  }
}
