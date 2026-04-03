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
  const collaborators = ctx.collaborators.list(taskId);
  const commentCounts = ctx.comments.countByTaskIds([taskId]);

  const include = optStringArray(args, 'include') ?? [];
  const result: Record<string, unknown> = {
    ...task,
    comments_count: commentCounts[taskId] ?? 0,
    dependencies: deps,
    collaborators,
  };

  if (include.includes('subtasks')) {
    result.subtasks = ctx.tasks.getSubtasks(taskId);
  }

  if (include.includes('artifacts')) {
    result.artifacts = ctx.tasks.getArtifacts(taskId, optString(args, 'stage'));
  } else {
    result.artifacts = ctx.tasks.getArtifacts(taskId);
  }

  if (include.includes('comments')) {
    result.comments = ctx.comments.list(taskId, optNumber(args, 'limit'));
  }

  return result;
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

export function handleUpdate(ctx: AppContext, args: Record<string, unknown>): unknown {
  const taskId = requireNumber(args, 'task_id');

  const dep = args.dependency as Record<string, unknown> | undefined;
  if (dep && typeof dep === 'object') {
    const depAction = validateEnum(
      dep.action as string | undefined,
      ['add', 'remove'] as const,
      'dependency.action',
    );
    const dependsOn = dep.depends_on;
    if (typeof dependsOn !== 'number') {
      throw new ValidationError('"dependency.depends_on" is required and must be a number.');
    }
    if (depAction === 'add') {
      const relationship = optionalEnum(
        dep.relationship as string | undefined,
        ['blocks', 'related', 'duplicate'] as const,
        'dependency.relationship',
        'blocks' as TaskRelationshipType,
      );
      ctx.tasks.addDependency(taskId, dependsOn, relationship);
    } else {
      ctx.tasks.removeDependency(taskId, dependsOn);
    }
  }

  const hasMetadataUpdate =
    optString(args, 'title') !== undefined ||
    optString(args, 'description') !== undefined ||
    optNumber(args, 'priority') !== undefined ||
    optString(args, 'project') !== undefined ||
    optStringArray(args, 'tags') !== undefined ||
    args.assign_to !== undefined;

  if (hasMetadataUpdate) {
    return ctx.tasks.update(taskId, {
      title: optString(args, 'title'),
      description: optString(args, 'description'),
      priority: optNumber(args, 'priority'),
      project: optString(args, 'project'),
      tags: optStringArray(args, 'tags'),
      assigned_to: optString(args, 'assign_to'),
    });
  }

  if (dep) {
    return {
      success: true,
      task_id: taskId,
      dependency: dep,
    };
  }

  return ctx.tasks.update(taskId, {});
}

export function handleDelete(ctx: AppContext, args: Record<string, unknown>): unknown {
  ctx.tasks.delete(requireNumber(args, 'task_id'));
  return { success: true };
}

// ---------------------------------------------------------------------------
// Consolidated: task_stage (claim, advance, regress, complete, fail, cancel)
// ---------------------------------------------------------------------------

export function handleStage(
  ctx: AppContext,
  args: Record<string, unknown>,
  session: SessionState,
): unknown {
  const action = validateEnum(
    optString(args, 'action'),
    ['claim', 'advance', 'regress', 'complete', 'fail', 'cancel'] as const,
    'action',
  );
  const taskId = requireNumber(args, 'task_id');

  if (action === 'claim') {
    const claimer = optString(args, 'claimer') ?? sessionName(session);
    return ctx.tasks.claim(taskId, claimer);
  }

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
// Consolidated: task_artifact (general, decision, learning, comment)
// ---------------------------------------------------------------------------

export function handleArtifact(
  ctx: AppContext,
  args: Record<string, unknown>,
  session: SessionState,
): unknown {
  const type = validateEnum(
    optString(args, 'type'),
    ['general', 'decision', 'learning', 'comment'] as const,
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

  if (type === 'learning') {
    return ctx.tasks.learn(
      taskId,
      requireString(args, 'content'),
      optString(args, 'category') ?? 'technique',
      sessionName(session),
    );
  }

  // type === 'comment'
  return ctx.comments.add(
    taskId,
    sessionName(session),
    requireString(args, 'content'),
    optNumber(args, 'parent_comment_id'),
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

// ---------------------------------------------------------------------------
// Dispatch map
// ---------------------------------------------------------------------------

export const handlers: Record<string, HandlerFn> = {
  task_create: handleCreate,
  task_get: handleGet,
  task_list: handleList,
  task_update: handleUpdate,
  task_delete: handleDelete,
  task_stage: handleStage,
  task_artifact: handleArtifact,
  task_config: handleConfig,
};
