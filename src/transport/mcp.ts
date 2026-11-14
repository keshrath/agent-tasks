// =============================================================================
// agent-tasks — MCP transport
//
// Maps MCP tool calls to the TaskService over the official MCP SDK. Thin
// adapter — validation lives in the domain layer, not here.
// =============================================================================

import { basename } from 'node:path';
import { Server, type Tool } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { readPackageMeta } from '../package-meta.js';
import { TasksError, ValidationError } from '../types.js';
import { handlers, type SessionState } from './mcp-handlers.js';

// ---------------------------------------------------------------------------
// Tool definitions (8 tools)
// ---------------------------------------------------------------------------

export const tools: Tool[] = [
  {
    name: 'task_create',
    description:
      'Create a pipeline task. Tasks start in "backlog" and move through stages: backlog → spec → plan → implement → test → review → done. Use parent_id to create subtasks under an existing task.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title (max 500 chars)' },
        description: { type: 'string', description: 'Detailed instructions (max 50K chars)' },
        assign_to: { type: 'string', description: 'Agent name to assign to' },
        stage: {
          type: 'string',
          description: 'Initial pipeline stage (default: backlog)',
        },
        priority: {
          type: 'number',
          description: 'Priority — higher number = more important (default: 0)',
        },
        project: { type: 'string', description: 'Project name for grouping' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        parent_id: {
          type: 'number',
          description: 'Parent task ID — creates a subtask that inherits project and priority',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'task_get',
    description:
      'Get a single task by ID. By default returns task with artifacts, comment count, dependencies (blockers/blocking = `blocks` edges; links = `related`/`duplicate`, with direction), claim status and collaborators. Use "include" to inline full subtasks, artifacts (filterable by stage), comments (with limit), or transitive_deps (full upstream + downstream closure of the dependency graph in one call — answers questions like "what depends on this task transitively?" and "what is its critical path depth?" without forcing the caller to BFS the graph).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID to retrieve' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['subtasks', 'artifacts', 'comments', 'transitive_deps'] },
          description:
            'Inline related data: "subtasks" → child tasks, "artifacts" → full artifact list (use stage to filter), "comments" → discussion threads (use limit to cap), "transitive_deps" → full upstream + downstream dependency closure with depth (one call answers transitive-impact questions)',
        },
        stage: {
          type: 'string',
          description: 'Filter artifacts by stage (only when include has "artifacts")',
        },
        limit: {
          type: 'number',
          description: 'Max comments to return (only when include has "comments", default: 100)',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_list',
    description:
      'List, search, or pick tasks. Without params: returns all tasks. With filters: narrow by status/stage/project/assignee. With "query": full-text search across titles and descriptions. With "next": true: returns the single highest-priority unassigned task with all dependencies met (uses affinity scoring when agent is provided).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Full-text search across task titles and descriptions (FTS5)',
        },
        next: {
          type: 'boolean',
          description:
            'Return the single best available task — highest priority, unassigned, all dependencies met. Uses affinity scoring when "agent" is provided.',
        },
        agent: {
          type: 'string',
          description:
            'Agent name for affinity scoring (only with next: true) — prefers tasks where the agent worked on the parent, a dependency, or the same project',
        },
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
        tags: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter by tags. Returns tasks that have ALL listed tags (AND-mode). Use one or more tag values, e.g. ["okr:OKR-H1-3", "iter:H1"].',
        },
        limit: {
          type: 'number',
          description: 'Max results (default: 500 for list, 50 for search)',
        },
        offset: { type: 'number', description: 'Skip first N results (for pagination)' },
      },
    },
  },
  {
    name: 'task_update',
    description:
      'Update task metadata — title, description, priority, tags, project, assignment, or dependencies. Does not change stage or status (use task_stage for that).',
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
        dependency: {
          type: 'object',
          description: 'Add or remove a dependency in the same call',
          properties: {
            action: {
              type: 'string',
              enum: ['add', 'remove'],
              description: 'Add or remove the dependency',
            },
            depends_on: { type: 'number', description: 'The task ID this task depends on' },
            relationship: {
              type: 'string',
              enum: ['blocks', 'related', 'duplicate'],
              description:
                'Relationship type (default: blocks, only for add). Only blocks gates advancement; related/duplicate show as links in task_get. One link per task pair.',
            },
          },
          required: ['action', 'depends_on'],
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_delete',
    description:
      'Delete a task with its artifacts, comments, dependencies and finished subtasks (all levels). Refused while any subtask below it is still open: finish, cancel or delete those first. Cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Task ID to delete' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_stage',
    description:
      'Move a task through its lifecycle. Actions: "claim" → assign to you and advance from backlog to spec, "assign" → assign to you WITHOUT advancing the stage (use for custom pipelines where the first stage is itself a do-work stage), "advance" → next stage (or jump to a specific one), "regress" → earlier stage (requires reason; back in the first stage it is unclaimed again), "complete" → marks done with result, "fail" → marks failed with error, "cancel" → cancels with reason, "reopen" → a failed, completed or cancelled task open again and unclaimed at the stage it was closed in (optional reason), ready to claim.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['claim', 'assign', 'advance', 'regress', 'complete', 'fail', 'cancel', 'reopen'],
          description: 'Lifecycle action to perform',
        },
        task_id: { type: 'number', description: 'Task ID' },
        claimer: {
          type: 'string',
          description: 'Agent name claiming (claim only, uses session name if omitted)',
        },
        stage: {
          type: 'string',
          description:
            'Target stage (advance: optional — advances to exactly the next if omitted; regress: required)',
        },
        from: {
          type: 'string',
          description:
            'advance only: the stage you saw the task in; refused if it moved elsewhere meanwhile',
        },
        comment: {
          type: 'string',
          description:
            'Comment (advance: optional, also satisfies stage-gate require_comment check)',
        },
        reason: {
          type: 'string',
          description: 'Reason for regression, cancellation or reopening',
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
    name: 'task_artifact',
    description:
      'Attach artifacts or comments to a task. Types: "general" → document (spec, test-results, review-notes), "decision" → structured decision record (chose/over/because), "learning" → insight that auto-propagates to parent and sibling tasks on completion, "comment" → discussion comment (supports threading via parent_comment_id, satisfies stage-gate require_comment checks).',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['general', 'decision', 'learning', 'comment'],
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
            'Artifact content (type: "general": text/markdown/JSON, max 100K; type: "learning": the insight; type: "comment": comment text)',
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
        parent_comment_id: {
          type: 'number',
          description: 'Reply to this comment (type: "comment" only, for threading)',
        },
      },
      required: ['type', 'task_id'],
    },
  },
  {
    name: 'task_config',
    description:
      'Configuration and admin. Actions: "session" → set agent identity (call this first), "pipeline" → get/set pipeline stages and gate config for a project, "cleanup" → purge old completed tasks, "rules" → generate IDE rule files (.mdc or CLAUDE.md).',
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
          enum: ['retention', 'sessions', 'all'],
          description:
            'Cleanup mode (cleanup only, default: retention). "sessions" fails the open tasks whose claiming session is gone now, without waiting for the next sweep.',
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
];

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export type ToolHandler = (
  name: string,
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;

/**
 * `holder` is what claims made through these tools live with (HolderService); `fallback` the
 * name they act under until `task_config` session names them.
 */
export function createToolHandler(
  ctx: AppContext,
  holder: string | null = null,
  fallback?: () => string,
): ToolHandler {
  const session: SessionState = { current: null, holder, fallback };

  return function handleTool(
    name: string,
    args: Record<string, unknown>,
  ): unknown | Promise<unknown> {
    const handler = handlers[name];
    if (!handler) throw new ValidationError(`Unknown tool: ${name}`);
    return handler(ctx, args, session);
  };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

/** Appended to every tool result so a client keeps the stage lifecycle in mind. */
export const PIPELINE_FOOTER =
  '\n\n---\nPIPELINE: Tasks flow through stages: backlog → spec → plan → implement → test → review → done. ' +
  'Always advance tasks through stages (task_stage action "advance"). Attach artifacts at each stage (task_artifact). ' +
  'Use task_list with next: true to pick up unblocked work. Discuss decisions with task_artifact type "comment".';

export interface McpServerOptions {
  /** Called once the client finished the initialize handshake. */
  onInitialized?: () => void;
  /** Append PIPELINE_FOOTER to tool results (AGENT_TASKS_INSTRUCTIONS=0 turns it off). */
  footer?: boolean;
  /** The holder claims made through this server live with. */
  holder?: string;
}

/**
 * The MCP server: the 8 tools, each result as pretty JSON text (plus the footer), a
 * failure as `Error [CODE]: message` with isError.
 */
export function createMcpServer(ctx: AppContext, options: McpServerOptions = {}): Server {
  const { name, version } = readPackageMeta();
  const server = new Server({ name, version }, { capabilities: { tools: {} } });
  // A readable name for an agent that never named itself: its client and project
  // (`claude-code@agent-tasks`), not `system`.
  const fallback = () => `${server.getClientVersion()?.name ?? 'agent'}@${basename(process.cwd())}`;
  const handleTool = createToolHandler(ctx, options.holder ?? null, fallback);
  const footer = options.footer === false ? '' : PIPELINE_FOOTER;

  server.setRequestHandler('tools/list', () => ({ tools }));
  server.setRequestHandler('tools/call', async (req) => {
    try {
      const result = await handleTool(req.params.name, req.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) + footer }] };
    } catch (err) {
      const code = err instanceof TasksError ? err.code : 'UNKNOWN_ERROR';
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error [${code}]: ${message}` }], isError: true };
    }
  });
  server.oninitialized = () => options.onInitialized?.();
  return server;
}
