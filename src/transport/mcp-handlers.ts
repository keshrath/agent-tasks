// =============================================================================
// agent-tasks — MCP tool handlers
//
// Individual handler functions for each MCP tool. Called from the dispatch
// map in mcp.ts. Validation helpers are co-located here.
// =============================================================================

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AppContext } from '../context.js';
import type { CollaboratorRole } from '../types.js';
import { ValidationError, type TaskRelationshipType } from '../types.js';
import { generateRules } from '../domain/rules.js';

// ---------------------------------------------------------------------------
// Session state (per-connection)
// ---------------------------------------------------------------------------

export interface SessionState {
  current: { id: string; name: string } | null;
}

export function sessionName(state: SessionState): string {
  return state.current?.name ?? 'system';
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

export function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string' || !val.trim()) {
    throw new ValidationError(`"${key}" must be a non-empty string.`);
  }
  return val;
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') throw new ValidationError(`"${key}" must be a string.`);
  return val;
}

export function requireNumber(args: Record<string, unknown>, key: string): number {
  const val = args[key];
  if (typeof val !== 'number') {
    throw new ValidationError(`"${key}" is required and must be a number.`);
  }
  return val;
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number') throw new ValidationError(`"${key}" must be a number.`);
  return val;
}

export function optBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'boolean') throw new ValidationError(`"${key}" must be a boolean.`);
  return val;
}

export function optStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
    throw new ValidationError(`"${key}" must be an array of strings.`);
  }
  return val as string[];
}

function validateEnum<T extends string>(
  val: string | undefined,
  allowed: readonly T[],
  label: string,
): T {
  if (!val) throw new ValidationError(`${label} is required`);
  if (!allowed.includes(val as T)) throw new ValidationError(`Invalid ${label}: ${val}`);
  return val as T;
}

function optionalEnum<T extends string>(
  val: string | undefined,
  allowed: readonly T[],
  label: string,
  defaultVal: T,
): T {
  if (val === undefined || val === null) return defaultVal;
  if (!allowed.includes(val as T)) throw new ValidationError(`Invalid ${label}: ${val}`);
  return val as T;
}

// ---------------------------------------------------------------------------
// Session file helper
// ---------------------------------------------------------------------------

function writeSessionFile(id: string, name: string): void {
  try {
    const claudeDir = join(homedir(), '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const filePath = join(claudeDir, `hub-session.${id}.json`);
    writeFileSync(
      filePath,
      JSON.stringify({ pid: process.pid, name, id, timestamp: new Date().toISOString() }),
    );
  } catch (err) {
    process.stderr.write(
      '[agent-tasks] writeSessionFile: ' +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
  }
}

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

export type HandlerFn = (
  ctx: AppContext,
  args: Record<string, unknown>,
  session: SessionState,
) => unknown | Promise<unknown>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleCreate(
  ctx: AppContext,
  args: Record<string, unknown>,
  session: SessionState,
): unknown {
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
    sessionName(session),
  );
}

export function handleGet(ctx: AppContext, args: Record<string, unknown>): unknown {
  const taskId = requireNumber(args, 'task_id');
  const task = ctx.tasks.getById(taskId);
  if (!task) throw new ValidationError(`Task ${taskId} not found.`);
  const deps = ctx.tasks.getDependencies(taskId);
  const artifacts = ctx.tasks.getArtifacts(taskId);
  const collaborators = ctx.collaborators.list(taskId);
  const commentCounts = ctx.comments.countByTaskIds([taskId]);
  return {
    ...task,
    artifacts,
    comments_count: commentCounts[taskId] ?? 0,
    dependencies: deps,
    collaborators,
  };
}

export function handleList(
  ctx: AppContext,
  args: Record<string, unknown>,
  session: SessionState,
): unknown {
  const query = optString(args, 'query');
  if (query) {
    return ctx.tasks.search(query, {
      project: optString(args, 'project'),
      limit: optNumber(args, 'limit'),
    });
  }

  const next = optBoolean(args, 'next');
  if (next) {
    const result = ctx.tasks.next(
      optString(args, 'project'),
      optString(args, 'stage'),
      optString(args, 'agent') ?? sessionName(session),
    );
    if (!result) return { message: 'No available tasks.' };
    return {
      ...result.task,
      affinity_score: result.affinity_score,
      affinity_reasons: result.affinity_reasons,
    };
  }

  return ctx.tasks.list({
    status: optString(args, 'status')
      ? validateEnum(
          optString(args, 'status'),
          ['pending', 'in_progress', 'completed', 'failed', 'cancelled'] as const,
          'status',
        )
      : undefined,
    assigned_to: optString(args, 'assign_to'),
    stage: optString(args, 'stage'),
    project: optString(args, 'project'),
    parent_id: optNumber(args, 'parent_id'),
    root_only: optBoolean(args, 'root_only'),
    collaborator: optString(args, 'collaborator'),
    limit: optNumber(args, 'limit'),
    offset: optNumber(args, 'offset'),
  });
}

export function handleClaim(
  ctx: AppContext,
  args: Record<string, unknown>,
  session: SessionState,
): unknown {
  const claimer = optString(args, 'claimer') ?? sessionName(session);
  return ctx.tasks.claim(requireNumber(args, 'task_id'), claimer);
}

export function handleUpdate(ctx: AppContext, args: Record<string, unknown>): unknown {
  return ctx.tasks.update(requireNumber(args, 'task_id'), {
    title: optString(args, 'title'),
    description: optString(args, 'description'),
    priority: optNumber(args, 'priority'),
    project: optString(args, 'project'),
    tags: optStringArray(args, 'tags'),
    assigned_to: optString(args, 'assign_to'),
  });
}

export function handleDelete(ctx: AppContext, args: Record<string, unknown>): unknown {
  ctx.tasks.delete(requireNumber(args, 'task_id'));
  return { success: true };
}

export function handleComment(
  ctx: AppContext,
  args: Record<string, unknown>,
  session: SessionState,
): unknown {
  return ctx.comments.add(
    requireNumber(args, 'task_id'),
    sessionName(session),
    requireString(args, 'content'),
    optNumber(args, 'parent_comment_id'),
  );
}

// ---------------------------------------------------------------------------
// Consolidated: task_stage (advance, regress, complete, fail, cancel)
// ---------------------------------------------------------------------------

export function handleStage(
  ctx: AppContext,
  args: Record<string, unknown>,
  session: SessionState,
): unknown {
  const action = validateEnum(
    optString(args, 'action'),
    ['advance', 'regress', 'complete', 'fail', 'cancel'] as const,
    'action',
  );
  const taskId = requireNumber(args, 'task_id');

  if (action === 'advance') {
    const advanceComment = optString(args, 'comment');
    const advanced = ctx.tasks.advance(taskId, optString(args, 'stage'), advanceComment);
    if (advanceComment) {
      ctx.comments.add(taskId, sessionName(session), advanceComment);
    }
    return advanced;
  }

  if (action === 'regress') {
    return ctx.tasks.regress(taskId, requireString(args, 'stage'), optString(args, 'reason'));
  }

  if (action === 'complete') {
    return ctx.tasks.complete(taskId, requireString(args, 'result'));
  }

  if (action === 'fail') {
    return ctx.tasks.fail(taskId, requireString(args, 'result'));
  }

  // action === 'cancel'
  return ctx.tasks.cancel(taskId, requireString(args, 'reason'));
}

// ---------------------------------------------------------------------------
// Consolidated: task_query (subtasks, artifacts, comments)
// ---------------------------------------------------------------------------

export function handleQuery(ctx: AppContext, args: Record<string, unknown>): unknown {
  const type = validateEnum(
    optString(args, 'type'),
    ['subtasks', 'artifacts', 'comments'] as const,
    'type',
  );
  const taskId = requireNumber(args, 'task_id');

  if (type === 'subtasks') {
    return ctx.tasks.getSubtasks(taskId);
  }

  if (type === 'artifacts') {
    return ctx.tasks.getArtifacts(taskId, optString(args, 'stage'));
  }

  // type === 'comments'
  return ctx.comments.list(taskId, optNumber(args, 'limit'));
}

// ---------------------------------------------------------------------------
// Consolidated: task_artifact (general, decision, learning)
// ---------------------------------------------------------------------------

export function handleArtifact(
  ctx: AppContext,
  args: Record<string, unknown>,
  session: SessionState,
): unknown {
  const type = validateEnum(
    optString(args, 'type'),
    ['general', 'decision', 'learning'] as const,
    'type',
  );
  const taskId = requireNumber(args, 'task_id');

  if (type === 'general') {
    return ctx.tasks.addArtifact(
      taskId,
      requireString(args, 'name'),
      requireString(args, 'content'),
      sessionName(session),
      optString(args, 'stage'),
    );
  }

  if (type === 'decision') {
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
    return ctx.tasks.addArtifact(taskId, 'decision', decisionContent, 'system', decisionStage);
  }

  // type === 'learning'
  return ctx.tasks.learn(
    taskId,
    requireString(args, 'content'),
    optString(args, 'category') ?? 'technique',
    sessionName(session),
  );
}

// ---------------------------------------------------------------------------
// Consolidated: task_config (pipeline, session, cleanup, rules)
// ---------------------------------------------------------------------------

export function handleConfig(
  ctx: AppContext,
  args: Record<string, unknown>,
  session: SessionState,
): unknown | Promise<unknown> {
  const action = validateEnum(
    optString(args, 'action'),
    ['pipeline', 'session', 'cleanup', 'rules'] as const,
    'action',
  );

  if (action === 'pipeline') {
    return handlePipelineConfig(ctx, args);
  }

  if (action === 'session') {
    const id = requireString(args, 'id');
    const sName = requireString(args, 'name');
    session.current = { id, name: sName };
    writeSessionFile(id, sName);
    return { success: true, id, name: sName };
  }

  if (action === 'cleanup') {
    return handleCleanup(ctx, args);
  }

  // action === 'rules'
  return handleGenerateRules(ctx, args);
}

function handlePipelineConfig(ctx: AppContext, args: Record<string, unknown>): unknown {
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

function handleCleanup(ctx: AppContext, args: Record<string, unknown>): unknown | Promise<unknown> {
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

function handleGenerateRules(ctx: AppContext, args: Record<string, unknown>): unknown {
  const format = requireString(args, 'format') as 'mdc' | 'claude_md';
  if (format !== 'mdc' && format !== 'claude_md') {
    throw new ValidationError('Format must be "mdc" or "claude_md".');
  }
  const project = optString(args, 'project');
  const stages = ctx.tasks.getPipelineStages(project);
  return { rules: generateRules(format, stages, project) };
}

export function handleDependency(ctx: AppContext, args: Record<string, unknown>): unknown {
  const action = validateEnum(optString(args, 'action'), ['add', 'remove'] as const, 'action');
  if (action === 'add') {
    const relationship = optionalEnum(
      optString(args, 'relationship'),
      ['blocks', 'related', 'duplicate'] as const,
      'relationship',
      'blocks' as TaskRelationshipType,
    );
    ctx.tasks.addDependency(
      requireNumber(args, 'task_id'),
      requireNumber(args, 'depends_on'),
      relationship,
    );
    return { success: true, task_id: args.task_id, depends_on: args.depends_on, relationship };
  }
  ctx.tasks.removeDependency(requireNumber(args, 'task_id'), requireNumber(args, 'depends_on'));
  return { success: true };
}

export function handleCollaborator(ctx: AppContext, args: Record<string, unknown>): unknown {
  const action = validateEnum(optString(args, 'action'), ['add', 'remove'] as const, 'action');
  if (action === 'add') {
    return ctx.collaborators.add(
      requireNumber(args, 'task_id'),
      requireString(args, 'agent_id'),
      optionalEnum(
        optString(args, 'role'),
        ['collaborator', 'reviewer', 'watcher'] as const,
        'role',
        'collaborator' as CollaboratorRole,
      ),
    );
  }
  ctx.collaborators.remove(requireNumber(args, 'task_id'), requireString(args, 'agent_id'));
  return { success: true };
}

export function handleApproval(
  ctx: AppContext,
  args: Record<string, unknown>,
  session: SessionState,
): unknown {
  const action = validateEnum(
    optString(args, 'action'),
    ['request', 'approve', 'reject', 'list', 'review'] as const,
    'action',
  );

  if (action === 'request') {
    const taskId = requireNumber(args, 'task_id');
    const task = ctx.tasks.getById(taskId);
    if (!task) throw new ValidationError(`Task ${taskId} not found.`);
    const stage = optString(args, 'stage') ?? task.stage;
    return ctx.approvals.request(taskId, stage, optString(args, 'reviewer'));
  }

  if (action === 'approve') {
    return ctx.approvals.approve(
      requireNumber(args, 'approval_id'),
      sessionName(session),
      optString(args, 'comment'),
    );
  }

  if (action === 'reject') {
    const approval = ctx.approvals.reject(
      requireNumber(args, 'approval_id'),
      sessionName(session),
      requireString(args, 'comment'),
    );
    const regressTo = optString(args, 'regress_to');
    if (regressTo) {
      ctx.tasks.regress(approval.task_id, regressTo, requireString(args, 'comment'));
    }
    return approval;
  }

  if (action === 'list') {
    return ctx.approvals.getPending(optString(args, 'reviewer'));
  }

  // action === 'review'
  const taskId = requireNumber(args, 'task_id');
  const decision = requireString(args, 'decision');
  const task = ctx.tasks.getById(taskId);
  if (!task) throw new ValidationError(`Task ${taskId} not found.`);

  if (decision === 'approve') {
    ctx.tasks.advance(taskId);
    return { success: true, action: 'approved', task: ctx.tasks.getById(taskId) };
  } else if (decision === 'reject') {
    const reason = requireString(args, 'reason');
    const regressTo = optString(args, 'regress_to') ?? 'implement';
    ctx.tasks.regress(taskId, regressTo, reason);
    return { success: true, action: 'rejected', task: ctx.tasks.getById(taskId) };
  } else {
    throw new ValidationError(`Invalid decision: ${decision}. Use "approve" or "reject".`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch map
// ---------------------------------------------------------------------------

export const handlers: Record<string, HandlerFn> = {
  task_create: handleCreate,
  task_get: handleGet,
  task_list: handleList,
  task_claim: handleClaim,
  task_update: handleUpdate,
  task_delete: handleDelete,
  task_comment: handleComment,
  task_stage: handleStage,
  task_query: handleQuery,
  task_artifact: handleArtifact,
  task_config: handleConfig,
  task_dependency: handleDependency,
  task_collaborator: handleCollaborator,
  task_approval: handleApproval,
};
