#!/usr/bin/env node

import { createInterface } from 'readline';
import { initDb, closeDb } from './db.js';
import { setSession, clearSession } from './session.js';
import {
  createTask,
  listTasks,
  claimTask,
  completeTask,
  failTask,
  cancelTask,
  advanceTask,
  regressTask,
  updateTask,
  nextTask,
  addDependency,
  removeDependency,
  addArtifact,
  getArtifacts,
  getPipelineStages,
  setPipelineConfig,
} from './tasks.js';
import type { JsonRpcRequest, JsonRpcResponse, ToolDefinition } from './types.js';

// ----------------------------------------------------------
// Tool Definitions
// ----------------------------------------------------------

const tools: ToolDefinition[] = [
  {
    name: 'task_create',
    description: 'Create a pipeline task with optional stage, priority, and project.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Detailed instructions' },
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
          description: 'Filter by status: pending, in_progress, completed, failed, cancelled',
        },
        assigned_to: { type: 'string', description: 'Filter by assigned agent name' },
        stage: { type: 'string', description: 'Filter by pipeline stage' },
        project: { type: 'string', description: 'Filter by project' },
        limit: { type: 'number', description: 'Max results (default: all, max: 500)' },
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
      'Advance a task to the next pipeline stage (or a specific stage). Validates dependencies are met.',
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
      'Get the highest-priority unassigned task with all dependencies met. Returns null if none available.',
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
    description: 'Make a task depend on another (task cannot advance past the dependency).',
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
          description: 'Artifact content (text, markdown, JSON)',
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
];

// ----------------------------------------------------------
// Tool Dispatch
// ----------------------------------------------------------

function handleToolCall(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'task_create':
      return createTask(
        args.title as string,
        args.description as string | undefined,
        args.assign_to as string | undefined,
        args.stage as string | undefined,
        args.priority as number | undefined,
        args.project as string | undefined,
        args.tags as string[] | undefined,
      );
    case 'task_list':
      return listTasks(
        args.status as string | undefined,
        args.assigned_to as string | undefined,
        args.stage as string | undefined,
        args.project as string | undefined,
        args.limit as number | undefined,
        args.offset as number | undefined,
      );
    case 'task_claim':
      return claimTask(args.task_id as number, args.claimer as string | undefined);
    case 'task_complete':
      return completeTask(args.task_id as number, args.result as string);
    case 'task_fail':
      return failTask(args.task_id as number, args.result as string);
    case 'task_cancel':
      return cancelTask(args.task_id as number, args.reason as string);
    case 'task_advance':
      return advanceTask(args.task_id as number, args.stage as string | undefined);
    case 'task_regress':
      return regressTask(
        args.task_id as number,
        args.stage as string,
        args.reason as string | undefined,
      );
    case 'task_update':
      return updateTask(args.task_id as number, {
        title: args.title as string | undefined,
        description: args.description as string | undefined,
        priority: args.priority as number | undefined,
        project: args.project as string | undefined,
        tags: args.tags as string[] | undefined,
        assigned_to: args.assign_to as string | undefined,
      });
    case 'task_next':
      return (
        nextTask(args.project as string | undefined, args.stage as string | undefined) ?? {
          message: 'No available tasks.',
        }
      );
    case 'task_add_dependency':
      addDependency(args.task_id as number, args.depends_on as number);
      return { success: true, task_id: args.task_id, depends_on: args.depends_on };
    case 'task_remove_dependency':
      removeDependency(args.task_id as number, args.depends_on as number);
      return { success: true };
    case 'task_add_artifact': {
      const artifactStage = args.stage as string | undefined;
      return addArtifact(
        args.task_id as number,
        artifactStage || '_current_',
        args.name as string,
        args.content as string,
      );
    }
    case 'task_get_artifacts':
      return getArtifacts(args.task_id as number, args.stage as string | undefined);
    case 'task_pipeline_config': {
      if (args.stages) {
        return setPipelineConfig((args.project as string) || 'default', args.stages as string[]);
      }
      return { stages: getPipelineStages(args.project as string | undefined) };
    }
    case 'task_set_session':
      setSession(args.id as string, args.name as string);
      return { success: true, id: args.id, name: args.name };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ----------------------------------------------------------
// JSON-RPC Handler
// ----------------------------------------------------------

const SERVER_INFO = {
  name: 'agent-tasks',
  version: '1.0.0',
};

const CAPABILITIES = {
  tools: {},
};

function handleRequest(request: JsonRpcRequest): JsonRpcResponse | null {
  const { method, params, id } = request;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: SERVER_INFO,
          capabilities: CAPABILITIES,
        },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools },
      };

    case 'tools/call': {
      const toolName = (params as { name: string }).name;
      const toolArgs = (params as { arguments?: Record<string, unknown> }).arguments || {};
      try {
        const result = handleToolCall(toolName, toolArgs);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          },
        };
      }
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ----------------------------------------------------------
// Stdio Transport
// ----------------------------------------------------------

function send(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  process.stdout.write(json + '\n');
}

async function main() {
  await initDb();

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      const response = handleRequest(request);
      if (response) send(response);
    } catch {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }
  });
}

main().catch((err) => {
  process.stderr.write(`Failed to start agent-tasks: ${err}\n`);
  process.exit(1);
});

// ----------------------------------------------------------
// Graceful Shutdown
// ----------------------------------------------------------

function cleanup() {
  clearSession();
  closeDb();
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('exit', cleanup);
