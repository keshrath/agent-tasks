// =============================================================================
// agent-tasks — Task domain service
//
// Core pipeline logic: CRUD, stage advancement, dependencies, artifacts.
// All mutations emit events. All inputs are validated.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type {
  Task,
  TaskArtifact,
  TaskCreateInput,
  TaskDependency,
  TaskListFilter,
  TaskRelationshipType,
  TaskStatus,
  TaskUpdateInput,
  PipelineConfig,
  GateConfig,
  SearchResult,
} from '../types.js';
import { NotFoundError, ConflictError, ValidationError } from '../types.js';
import {
  MAX_STAGE_NAME_LENGTH,
  MAX_STAGES_COUNT,
  MAX_LIST_LIMIT,
  rejectNullBytes,
  rejectControlChars,
} from './validate.js';
import {
  validateTitle,
  validateDescription,
  validateResult,
  validateProjectName,
  validateAssignee,
  validateTags,
  validateArtifactName,
  validateArtifactContent,
} from './task-validator.js';
import { scoreTaskConfidence, type ConfidenceScore } from './confidence.js';

export const DEFAULT_STAGES = [
  'backlog',
  'spec',
  'plan',
  'implement',
  'test',
  'review',
  'done',
  'cancelled',
];

const VALID_STATUSES: readonly TaskStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
];

export class TaskService {
  private configCache = new Map<
    string,
    { stages: string[]; gate: GateConfig | null; at: number }
  >();
  private static readonly CONFIG_CACHE_TTL = 30_000;

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  // ---- Pipeline Config (cached) ----

  private getCachedConfig(project: string): { stages: string[]; gate: GateConfig | null } | null {
    const entry = this.configCache.get(project);
    if (entry && Date.now() - entry.at < TaskService.CONFIG_CACHE_TTL) {
      return { stages: entry.stages, gate: entry.gate };
    }
    return null;
  }

  private invalidateConfigCache(project: string): void {
    this.configCache.delete(project);
  }

  private loadAndCacheConfig(project: string): { stages: string[]; gate: GateConfig | null } {
    const config = this.db.queryOne<PipelineConfig>(
      'SELECT * FROM pipeline_config WHERE project = ?',
      [project],
    );
    let stages = [...DEFAULT_STAGES];
    let gate: GateConfig | null = null;
    if (config) {
      try {
        stages = JSON.parse(config.stages);
      } catch {
        // fall back to defaults
      }
      if (config.gate_config) {
        try {
          gate = JSON.parse(config.gate_config) as GateConfig;
        } catch {
          // fall back to null
        }
      }
    }
    this.configCache.set(project, { stages, gate, at: Date.now() });
    return { stages, gate };
  }

  getPipelineStages(project?: string): string[] {
    if (!project) return [...DEFAULT_STAGES];
    const cached = this.getCachedConfig(project);
    if (cached) return cached.stages;
    return this.loadAndCacheConfig(project).stages;
  }

  getAllGateConfigs(): Record<string, GateConfig> {
    const configs = this.db.queryAll<PipelineConfig>(
      'SELECT * FROM pipeline_config WHERE gate_config IS NOT NULL',
    );
    const result: Record<string, GateConfig> = {};
    for (const c of configs) {
      try {
        const gate = JSON.parse(c.gate_config!) as GateConfig;
        result[c.project] = gate;
        const cached = this.configCache.get(c.project);
        if (cached) {
          cached.gate = gate;
          cached.at = Date.now();
        }
      } catch {
        // skip corrupt entries
      }
    }
    return result;
  }

  getGateConfig(project?: string): GateConfig | null {
    if (!project) return null;
    const cached = this.getCachedConfig(project);
    if (cached) return cached.gate;
    return this.loadAndCacheConfig(project).gate;
  }

  setGateConfig(project: string, gateConfig: GateConfig): PipelineConfig {
    validateProjectName(project);
    const json = JSON.stringify(gateConfig);
    this.db.run(
      `INSERT INTO pipeline_config (project, stages, gate_config, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(project) DO UPDATE SET gate_config = ?, updated_at = datetime('now')`,
      [project, JSON.stringify(this.getPipelineStages(project)), json, json],
    );
    this.invalidateConfigCache(project);
    return this.db.queryOne<PipelineConfig>('SELECT * FROM pipeline_config WHERE project = ?', [
      project,
    ])!;
  }

  setPipelineConfig(project: string, stages: string[]): PipelineConfig {
    validateProjectName(project);
    if (!stages.length) throw new ValidationError('Stages array cannot be empty.');
    if (stages.length > MAX_STAGES_COUNT) {
      throw new ValidationError(`Too many stages (max ${MAX_STAGES_COUNT}).`);
    }

    const seen = new Set<string>();
    for (const s of stages) {
      if (s.length > MAX_STAGE_NAME_LENGTH) {
        throw new ValidationError(`Stage name too long: "${s}" (max ${MAX_STAGE_NAME_LENGTH}).`);
      }
      rejectControlChars(s, 'stage name');
      rejectNullBytes(s, 'stage name');
      if (seen.has(s)) throw new ConflictError(`Duplicate stage: ${s}`);
      seen.add(s);
    }

    const json = JSON.stringify(stages);
    this.db.run(
      `INSERT INTO pipeline_config (project, stages, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(project) DO UPDATE SET stages = ?, updated_at = datetime('now')`,
      [project, json, json],
    );
    this.invalidateConfigCache(project);
    this.events.emit('pipeline:configured', { project, stages });
    return this.db.queryOne<PipelineConfig>('SELECT * FROM pipeline_config WHERE project = ?', [
      project,
    ])!;
  }

  // ---- CRUD ----

  create(input: TaskCreateInput, createdBy: string): Task {
    validateTitle(input.title);
    if (input.description !== undefined) validateDescription(input.description);
    if (input.project !== undefined) validateProjectName(input.project);
    if (input.tags !== undefined) validateTags(input.tags);
    if (input.assign_to !== undefined) validateAssignee(input.assign_to);
    if (input.parent_id !== undefined) this.requireTask(input.parent_id);

    const stages = this.getPipelineStages(input.project);
    const effectiveStage = input.stage || stages[0];
    this.validateStage(effectiveStage, stages);

    const status = syncStatusForStage(effectiveStage, stages);

    const result = this.db.run(
      `INSERT INTO tasks (title, description, created_by, assigned_to, status, stage, priority, project, tags, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.title.trim(),
        input.description?.trim() ?? null,
        createdBy,
        input.assign_to ?? null,
        status,
        effectiveStage,
        input.priority ?? 0,
        input.project ?? null,
        input.tags ? JSON.stringify(input.tags) : null,
        input.parent_id ?? null,
      ],
    );

    const task = this.getById(Number(result.lastInsertRowid))!;
    this.events.emit('task:created', { task });
    return task;
  }

  update(taskId: number, updates: TaskUpdateInput): Task {
    const task = this.requireTask(taskId);

    if (updates.title !== undefined) validateTitle(updates.title);
    if (updates.description !== undefined) validateDescription(updates.description);
    if (updates.project !== undefined) validateProjectName(updates.project);
    if (updates.tags !== undefined) validateTags(updates.tags);
    if (updates.assigned_to !== undefined && updates.assigned_to !== '') {
      validateAssignee(updates.assigned_to);
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.title !== undefined) {
      sets.push('title = ?');
      params.push(updates.title.trim());
    }
    if (updates.description !== undefined) {
      sets.push('description = ?');
      params.push(updates.description.trim());
    }
    if (updates.priority !== undefined) {
      sets.push('priority = ?');
      params.push(updates.priority);
    }
    if (updates.project !== undefined) {
      sets.push('project = ?');
      params.push(updates.project);
    }
    if (updates.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(updates.tags));
    }
    if (updates.assigned_to !== undefined) {
      sets.push('assigned_to = ?');
      params.push(updates.assigned_to || null);
    }

    if (!sets.length) throw new ValidationError('No fields to update.');

    sets.push("updated_at = datetime('now')");
    params.push(taskId);

    this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params);
    const updated = this.getById(taskId)!;
    this.events.emit('task:updated', { task: updated, previous: task });
    return updated;
  }

  list(filter: TaskListFilter = {}): Task[] {
    if (filter.status && !VALID_STATUSES.includes(filter.status)) {
      throw new ValidationError(
        `Invalid status: ${filter.status}. Valid: ${VALID_STATUSES.join(', ')}`,
      );
    }

    let sql = 'SELECT DISTINCT t.* FROM tasks t';
    const params: unknown[] = [];

    if (filter.collaborator) {
      sql += ' JOIN task_collaborators tc ON tc.task_id = t.id';
    }

    sql += ' WHERE 1=1';

    if (filter.status) {
      sql += ' AND t.status = ?';
      params.push(filter.status);
    }
    if (filter.assigned_to) {
      sql += ' AND t.assigned_to = ?';
      params.push(filter.assigned_to);
    }
    if (filter.stage) {
      sql += ' AND t.stage = ?';
      params.push(filter.stage);
    }
    if (filter.project) {
      sql += ' AND t.project = ?';
      params.push(filter.project);
    }
    if (filter.parent_id !== undefined) {
      sql += ' AND t.parent_id = ?';
      params.push(filter.parent_id);
    }
    if (filter.root_only) {
      sql += ' AND t.parent_id IS NULL';
    }
    if (filter.collaborator) {
      sql += ' AND tc.agent_id = ?';
      params.push(filter.collaborator);
    }

    sql += ' ORDER BY t.priority DESC, t.created_at DESC';

    const limit = Math.min(filter.limit ?? MAX_LIST_LIMIT, MAX_LIST_LIMIT);
    sql += ' LIMIT ?';
    params.push(limit);

    if (filter.offset && filter.offset > 0) {
      sql += ' OFFSET ?';
      params.push(filter.offset);
    }

    return this.db.queryAll<Task>(sql, params);
  }

  getById(id: number): Task | null {
    return this.db.queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
  }

  count(filter?: { status?: TaskStatus; project?: string; stage?: string }): number {
    let sql = 'SELECT COUNT(*) as cnt FROM tasks';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter?.project) {
      conditions.push('project = ?');
      params.push(filter.project);
    }
    if (filter?.stage) {
      conditions.push('stage = ?');
      params.push(filter.stage);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');

    const row = this.db.queryOne<{ cnt: number }>(sql, params);
    return row?.cnt ?? 0;
  }

  // ---- Claiming ----

  /**
   * Score a task's clarity using deterministic heuristics. Surface for
   * dashboards/CLIs that want to show authors how to improve a task before
   * an agent claims it.
   */
  scoreConfidence(taskId: number): ConfidenceScore {
    const task = this.requireTask(taskId);
    return scoreTaskConfidence({ title: task.title, description: task.description });
  }

  /**
   * Look up the per-stage instruction string for a project (if configured
   * via gate.stage_instructions). Returns null when nothing is set.
   */
  getStageInstructions(project: string | null | undefined, stage: string): string | null {
    const gate = this.getGateConfig(project ?? undefined);
    return gate?.stage_instructions?.[stage] ?? null;
  }

  claim(taskId: number, claimerName: string): Task {
    validateAssignee(claimerName);

    return this.db.transaction(() => {
      const task = this.requireTask(taskId);
      if (task.status !== 'pending') {
        throw new ConflictError(`Task ${taskId} is not pending (status: ${task.status}).`);
      }

      // Confidence gate: refuse to hand a vague task to an agent if a
      // threshold is configured for the project.
      const gate = this.getGateConfig(task.project ?? undefined);
      const minConfidence = gate?.min_confidence_for_claim;
      if (typeof minConfidence === 'number' && minConfidence > 0) {
        const { score, reasons } = scoreTaskConfidence({
          title: task.title,
          description: task.description,
        });
        if (score < minConfidence) {
          const detail = reasons.length ? ` Issues: ${reasons.join('; ')}` : '';
          throw new ValidationError(
            `Task ${taskId} confidence ${score}/100 below required ${minConfidence}.${detail}`,
          );
        }
      }

      const stages = this.getPipelineStages(task.project ?? undefined);
      const firstStage = stages[0];
      const nextStage = stages.length > 1 ? stages[1] : firstStage;
      const newStage = task.stage === firstStage ? nextStage : task.stage;
      const newStatus = syncStatusForStage(newStage, stages);

      this.db.run(
        `UPDATE tasks SET status = ?, stage = ?, assigned_to = ?, updated_at = datetime('now') WHERE id = ?`,
        [newStatus, newStage, claimerName, taskId],
      );
      const claimed = this.getById(taskId)!;
      this.events.emit('task:claimed', { task: claimed, claimer: claimerName });
      return claimed;
    });
  }

  // ---- Learnings ----

  learn(
    taskId: number,
    content: string,
    category: string = 'technique',
    createdBy: string = 'system',
  ): TaskArtifact {
    const validCategories = ['technique', 'pitfall', 'decision', 'pattern'];
    if (!validCategories.includes(category)) {
      throw new ValidationError(
        `Invalid learning category: ${category}. Valid: ${validCategories.join(', ')}`,
      );
    }
    validateArtifactContent(content);

    const task = this.requireTask(taskId);
    const prefixedContent = `[${category}] ${content}`;
    return this.addArtifact(taskId, 'learning', prefixedContent, createdBy, task.stage);
  }

  private propagateLearnings(task: Task): void {
    if (!task.parent_id) return;

    const learnings = this.db.queryAll<TaskArtifact>(
      `SELECT * FROM task_artifacts WHERE task_id = ? AND name = 'learning' ORDER BY created_at ASC`,
      [task.id],
    );

    if (learnings.length === 0) return;

    for (const learning of learnings) {
      const parentContent = `Learning from subtask #${task.id}: ${learning.content}`;
      this.addArtifact(task.parent_id, 'learning', parentContent, 'system');
    }

    const siblings = this.db.queryAll<Task>(
      `SELECT * FROM tasks WHERE parent_id = ? AND id != ? AND status = 'in_progress'`,
      [task.parent_id, task.id],
    );

    for (const sibling of siblings) {
      for (const learning of learnings) {
        const siblingContent = `Learning from sibling #${task.id}: ${learning.content}`;
        this.addArtifact(sibling.id, 'learning', siblingContent, 'system');
      }
    }
  }

  // ---- Completion / Failure / Cancellation ----

  complete(taskId: number, result: string): Task {
    validateResult(result);

    return this.db.transaction(() => {
      const task = this.requireTask(taskId);
      if (task.status !== 'in_progress') {
        throw new ConflictError(`Task ${taskId} not in progress (status: ${task.status}).`);
      }

      const stages = this.getPipelineStages(task.project ?? undefined);
      const doneStage = stages.filter((s) => s !== 'cancelled').pop() ?? 'done';

      this.db.run(
        `UPDATE tasks SET status = 'completed', stage = ?, result = ?, updated_at = datetime('now') WHERE id = ?`,
        [doneStage, result, taskId],
      );

      this.propagateLearnings(task);

      const completed = this.getById(taskId)!;
      this.events.emit('task:completed', { task: completed });
      return completed;
    });
  }

  fail(taskId: number, result: string): Task {
    validateResult(result);

    return this.db.transaction(() => {
      const task = this.requireTask(taskId);
      if (task.status !== 'in_progress') {
        throw new ConflictError(`Task ${taskId} not in progress (status: ${task.status}).`);
      }

      this.db.run(
        `UPDATE tasks SET status = 'failed', result = ?, updated_at = datetime('now') WHERE id = ?`,
        [result, taskId],
      );
      const failed = this.getById(taskId)!;
      this.events.emit('task:failed', { task: failed });
      return failed;
    });
  }

  cancel(taskId: number, reason: string): Task {
    validateResult(reason);

    return this.db.transaction(() => {
      const task = this.requireTask(taskId);
      if (task.status === 'completed' || task.status === 'cancelled') {
        throw new ConflictError(`Task ${taskId} is already ${task.status}.`);
      }

      this.db.run(
        `UPDATE tasks SET status = 'cancelled', stage = 'cancelled', result = ?, updated_at = datetime('now') WHERE id = ?`,
        [reason, taskId],
      );
      const cancelled = this.getById(taskId)!;
      this.events.emit('task:cancelled', { task: cancelled });
      return cancelled;
    });
  }

  // ---- Pipeline Advancement ----

  advance(taskId: number, toStage?: string, comment?: string): Task {
    return this.db.transaction(() => {
      const task = this.requireTask(taskId);
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        throw new ConflictError(`Task ${taskId} is ${task.status} — cannot advance.`);
      }

      const stages = this.getPipelineStages(task.project ?? undefined);
      const activeStages = stages.filter((s) => s !== 'cancelled');
      const currentIdx = activeStages.indexOf(task.stage);
      if (currentIdx === -1) {
        throw new ValidationError(`Task stage '${task.stage}' not in pipeline.`);
      }

      let targetIdx: number;
      if (toStage) {
        if (toStage === 'cancelled') {
          throw new ValidationError('Use task_cancel to cancel a task.');
        }
        targetIdx = activeStages.indexOf(toStage);
        if (targetIdx === -1) {
          throw new ValidationError(
            `Invalid target stage: ${toStage}. Valid: ${activeStages.join(', ')}`,
          );
        }
        if (targetIdx <= currentIdx) {
          throw new ValidationError(
            `Target stage '${toStage}' is not ahead of current stage '${task.stage}'. Use task_regress to move backward.`,
          );
        }
      } else {
        targetIdx = currentIdx + 1;
        if (targetIdx >= activeStages.length) {
          throw new ConflictError(`Task is already at the final stage: ${task.stage}.`);
        }
      }

      this.checkDependencies(taskId);
      this.checkStageGate(task, comment);

      const newStage = activeStages[targetIdx];
      const newStatus = syncStatusForStage(newStage, activeStages);

      const autoAssignee = this.getAutoAssignee(newStage, task.project ?? undefined);

      this.db.run(
        `UPDATE tasks SET stage = ?, status = ?, ${autoAssignee ? 'assigned_to = ?, ' : ''}updated_at = datetime('now') WHERE id = ?`,
        autoAssignee ? [newStage, newStatus, autoAssignee, taskId] : [newStage, newStatus, taskId],
      );
      const advanced = this.getById(taskId)!;
      this.events.emit('task:advanced', {
        task: advanced,
        from_stage: task.stage,
        to_stage: newStage,
      });
      return advanced;
    });
  }

  regress(taskId: number, toStage: string, reason?: string): Task {
    return this.db.transaction(() => {
      const task = this.requireTask(taskId);

      const stages = this.getPipelineStages(task.project ?? undefined);
      const currentIdx = stages.indexOf(task.stage);
      const targetIdx = stages.indexOf(toStage);
      if (targetIdx === -1) {
        throw new ValidationError(`Invalid target stage: ${toStage}. Valid: ${stages.join(', ')}`);
      }
      if (targetIdx >= currentIdx) {
        throw new ValidationError(
          `Target stage '${toStage}' is not before current stage '${task.stage}'.`,
        );
      }

      const newStatus = syncStatusForStage(toStage, stages);

      this.db.run(
        `UPDATE tasks SET stage = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
        [toStage, newStatus, taskId],
      );

      if (reason) {
        validateResult(reason);
        this.db.run(
          `INSERT INTO task_artifacts (task_id, stage, name, content, created_by) VALUES (?, ?, ?, ?, ?)`,
          [
            taskId,
            task.stage,
            'rejection',
            `Regressed from ${task.stage} to ${toStage}: ${reason}`,
            'system',
          ],
        );
      }

      const regressed = this.getById(taskId)!;
      this.events.emit('task:regressed', {
        task: regressed,
        from_stage: task.stage,
        to_stage: toStage,
        reason,
      });
      return regressed;
    });
  }

  // ---- Next Task ----

  next(
    project?: string,
    stage?: string,
    agent?: string,
  ): { task: Task; affinity_score: number; affinity_reasons: string[] } | null {
    let sql = `SELECT t.* FROM tasks t WHERE t.status IN ('pending', 'in_progress') AND t.assigned_to IS NULL`;
    const params: unknown[] = [];

    if (project) {
      sql += ' AND t.project = ?';
      params.push(project);
    }
    if (stage) {
      sql += ' AND t.stage = ?';
      params.push(stage);
    }

    sql += ` AND NOT EXISTS (
      SELECT 1 FROM task_dependencies d
      JOIN tasks dep ON dep.id = d.depends_on
      WHERE d.task_id = t.id AND d.relationship = 'blocks' AND dep.status NOT IN ('completed', 'cancelled', 'failed')
    )`;

    sql += ' ORDER BY t.priority DESC, t.created_at ASC LIMIT 50';

    const candidates = this.db.queryAll<Task>(sql, params);
    if (candidates.length === 0) return null;

    if (!agent || candidates.length === 1) {
      return { task: candidates[0], affinity_score: 0, affinity_reasons: [] };
    }

    const topPriority = candidates[0].priority;
    const topCandidates = candidates.filter((t) => t.priority === topPriority);

    if (topCandidates.length <= 1) {
      return { task: candidates[0], affinity_score: 0, affinity_reasons: [] };
    }

    const scored = this.computeAffinityBatch(topCandidates, agent);

    let bestTask = topCandidates[0];
    let bestScore = 0;
    let bestReasons: string[] = [];

    for (const { task: t, score, reasons } of scored) {
      if (score > bestScore) {
        bestScore = score;
        bestReasons = reasons;
        bestTask = t;
      }
    }

    return { task: bestTask, affinity_score: bestScore, affinity_reasons: bestReasons };
  }

  private computeAffinityBatch(
    tasks: Task[],
    agent: string,
  ): { task: Task; score: number; reasons: string[] }[] {
    const parentIds = [...new Set(tasks.map((t) => t.parent_id).filter((id) => id !== null))];
    const parentMap = new Map<number, Task>();
    if (parentIds.length > 0) {
      const placeholders = parentIds.map(() => '?').join(',');
      const parents = this.db.queryAll<Task>(
        `SELECT * FROM tasks WHERE id IN (${placeholders})`,
        parentIds,
      );
      for (const p of parents) parentMap.set(p.id, p);
    }

    const taskIds = tasks.map((t) => t.id);
    const depsMap = new Map<number, TaskDependency[]>();
    if (taskIds.length > 0) {
      const placeholders = taskIds.map(() => '?').join(',');
      const allDeps = this.db.queryAll<TaskDependency>(
        `SELECT * FROM task_dependencies WHERE task_id IN (${placeholders}) AND relationship = 'blocks'`,
        taskIds,
      );
      for (const d of allDeps) {
        let arr = depsMap.get(d.task_id);
        if (!arr) {
          arr = [];
          depsMap.set(d.task_id, arr);
        }
        arr.push(d);
      }
    }

    const depTargetIds = new Set<number>();
    for (const deps of depsMap.values()) {
      for (const d of deps) depTargetIds.add(d.depends_on);
    }
    const depTaskMap = new Map<number, Task>();
    if (depTargetIds.size > 0) {
      const placeholders = [...depTargetIds].map(() => '?').join(',');
      const depTasks = this.db.queryAll<Task>(`SELECT * FROM tasks WHERE id IN (${placeholders})`, [
        ...depTargetIds,
      ]);
      for (const t of depTasks) depTaskMap.set(t.id, t);
    }

    const projects = [...new Set(tasks.map((t) => t.project).filter((p) => p !== null))];
    const projectCounts = new Map<string, number>();
    if (projects.length > 0) {
      const placeholders = projects.map(() => '?').join(',');
      const rows = this.db.queryAll<{ project: string; cnt: number }>(
        `SELECT project, COUNT(*) as cnt FROM tasks WHERE project IN (${placeholders}) AND assigned_to = ? AND status IN ('completed', 'in_progress') GROUP BY project`,
        [...projects, agent],
      );
      for (const r of rows) projectCounts.set(r.project, r.cnt);
    }

    return tasks.map((task) => {
      let score = 0;
      const reasons: string[] = [];

      if (task.parent_id) {
        const parent = parentMap.get(task.parent_id);
        if (parent?.assigned_to === agent) {
          score += 3;
          reasons.push('worked on parent task');
        }
      }

      const deps = depsMap.get(task.id) ?? [];
      for (const dep of deps) {
        const depTask = depTaskMap.get(dep.depends_on);
        if (depTask?.assigned_to === agent) {
          score += 2;
          reasons.push('worked on dependency #' + dep.depends_on);
          break;
        }
      }

      if (task.project) {
        const cnt = projectCounts.get(task.project) ?? 0;
        if (cnt > 0) {
          score += 1;
          reasons.push('worked on project ' + task.project);
        }
      }

      return { task, score, reasons };
    });
  }

  // ---- Dependencies ----

  addDependency(
    taskId: number,
    dependsOn: number,
    relationship: TaskRelationshipType = 'blocks',
  ): void {
    if (taskId === dependsOn) {
      throw new ValidationError('A task cannot depend on itself.');
    }

    const validRelationships: TaskRelationshipType[] = ['blocks', 'related', 'duplicate'];
    if (!validRelationships.includes(relationship)) {
      throw new ValidationError(
        `Invalid relationship type: ${relationship}. Valid: ${validRelationships.join(', ')}`,
      );
    }

    this.requireTask(taskId);
    this.requireTask(dependsOn);

    if (relationship === 'blocks' && this.wouldCreateCycle(taskId, dependsOn)) {
      throw new ConflictError(`Adding dependency ${taskId} → ${dependsOn} would create a cycle.`);
    }

    try {
      this.db.run(
        'INSERT INTO task_dependencies (task_id, depends_on, relationship) VALUES (?, ?, ?)',
        [taskId, dependsOn, relationship],
      );
    } catch {
      throw new ConflictError(`Dependency ${taskId} → ${dependsOn} already exists.`);
    }
    this.events.emit('dependency:added', { task_id: taskId, depends_on: dependsOn, relationship });
  }

  removeDependency(taskId: number, dependsOn: number): void {
    const result = this.db.run(
      'DELETE FROM task_dependencies WHERE task_id = ? AND depends_on = ?',
      [taskId, dependsOn],
    );
    if (result.changes === 0) {
      throw new NotFoundError('Dependency', `${taskId} → ${dependsOn}`);
    }
    this.events.emit('dependency:removed', { task_id: taskId, depends_on: dependsOn });
  }

  getDependencies(taskId: number): { blockers: Task[]; blocking: Task[] } {
    this.requireTask(taskId);
    return {
      blockers: this.db.queryAll<Task>(
        'SELECT t.* FROM tasks t JOIN task_dependencies d ON t.id = d.depends_on WHERE d.task_id = ?',
        [taskId],
      ),
      blocking: this.db.queryAll<Task>(
        'SELECT t.* FROM tasks t JOIN task_dependencies d ON t.id = d.task_id WHERE d.depends_on = ?',
        [taskId],
      ),
    };
  }

  getAllDependencies(): TaskDependency[] {
    return this.db.queryAll<TaskDependency>('SELECT * FROM task_dependencies');
  }

  getDependenciesForTasks(taskIds: number[]): TaskDependency[] {
    if (taskIds.length === 0) return [];
    const placeholders = taskIds.map(() => '?').join(',');
    return this.db.queryAll<TaskDependency>(
      `SELECT * FROM task_dependencies WHERE task_id IN (${placeholders}) OR depends_on IN (${placeholders})`,
      [...taskIds, ...taskIds],
    );
  }

  /**
   * Walks the `blocks` dependency graph in both directions from `taskId` and
   * returns the FULL transitive closure: every task that this task depends
   * on (directly or via a chain), and every task that depends on this task.
   *
   * Used by callers that need to answer questions like "what's the critical
   * path?", "what's the downstream impact if X fails?", "list every task
   * that transitively depends on X". Doing those queries via repeated
   * `getDependencies` calls forces the caller to implement BFS themselves
   * — which LLMs are bad at. This is one round-trip and the answer is
   * directly usable.
   */
  getDependencyClosure(taskId: number): {
    blockers_transitive: Task[];
    blocking_transitive: Task[];
    depth_blockers: number;
    depth_blocking: number;
  } {
    this.requireTask(taskId);

    // Walk upstream (everything this task depends on, transitively).
    const blockerIds = new Set<number>();
    const blockerStack: Array<{ id: number; depth: number }> = [];
    let maxDepthBlockers = 0;
    {
      const direct = this.db.queryAll<TaskDependency>(
        `SELECT * FROM task_dependencies WHERE task_id = ? AND relationship = 'blocks'`,
        [taskId],
      );
      for (const d of direct) blockerStack.push({ id: d.depends_on, depth: 1 });
    }
    while (blockerStack.length) {
      const { id, depth } = blockerStack.pop()!;
      if (blockerIds.has(id)) continue;
      blockerIds.add(id);
      if (depth > maxDepthBlockers) maxDepthBlockers = depth;
      const next = this.db.queryAll<TaskDependency>(
        `SELECT * FROM task_dependencies WHERE task_id = ? AND relationship = 'blocks'`,
        [id],
      );
      for (const d of next) blockerStack.push({ id: d.depends_on, depth: depth + 1 });
    }

    // Walk downstream (everything that depends on this task, transitively).
    const blockingIds = new Set<number>();
    const blockingStack: Array<{ id: number; depth: number }> = [];
    let maxDepthBlocking = 0;
    {
      const direct = this.db.queryAll<TaskDependency>(
        `SELECT * FROM task_dependencies WHERE depends_on = ? AND relationship = 'blocks'`,
        [taskId],
      );
      for (const d of direct) blockingStack.push({ id: d.task_id, depth: 1 });
    }
    while (blockingStack.length) {
      const { id, depth } = blockingStack.pop()!;
      if (blockingIds.has(id)) continue;
      blockingIds.add(id);
      if (depth > maxDepthBlocking) maxDepthBlocking = depth;
      const next = this.db.queryAll<TaskDependency>(
        `SELECT * FROM task_dependencies WHERE depends_on = ? AND relationship = 'blocks'`,
        [id],
      );
      for (const d of next) blockingStack.push({ id: d.task_id, depth: depth + 1 });
    }

    const blockers_transitive = this.fetchTasksByIds([...blockerIds]);
    const blocking_transitive = this.fetchTasksByIds([...blockingIds]);
    return {
      blockers_transitive,
      blocking_transitive,
      depth_blockers: maxDepthBlockers,
      depth_blocking: maxDepthBlocking,
    };
  }

  private fetchTasksByIds(ids: number[]): Task[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.queryAll<Task>(
      `SELECT * FROM tasks WHERE id IN (${placeholders}) ORDER BY id ASC`,
      ids,
    );
  }

  /**
   * Returns whether a task can be claimed RIGHT NOW (its direct `blocks`
   * dependencies are all done) and, if not, lists the specific incomplete
   * blocker tasks. A pre-computed view of what `claim()` would either
   * accept or reject — so callers can show "claimable" or "blocked by X, Y"
   * in a UI without trying claim and catching the exception.
   *
   * `claimable` is true iff every direct blocker has status in
   * (completed, cancelled, failed). Tasks that are already in_progress
   * or completed themselves are still reported with their current status,
   * so the caller can also use this to answer "could a fresh worker pick
   * this up?" — answer is `claimable && status === 'pending'`.
   */
  getClaimStatus(taskId: number): {
    status: string;
    claimable: boolean;
    blocked_by: Array<{ id: number; title: string; status: string; stage: string }>;
  } {
    const task = this.requireTask(taskId);
    const blockers = this.db.queryAll<Task>(
      `SELECT t.* FROM tasks t JOIN task_dependencies d ON t.id = d.depends_on
       WHERE d.task_id = ? AND d.relationship = 'blocks' AND t.status NOT IN ('completed', 'cancelled', 'failed')`,
      [taskId],
    );
    return {
      status: task.status,
      claimable: blockers.length === 0,
      blocked_by: blockers.map((b) => ({
        id: b.id,
        title: b.title,
        status: b.status,
        stage: b.stage,
      })),
    };
  }

  // ---- Artifacts ----

  addArtifact(
    taskId: number,
    name: string,
    content: string,
    createdBy: string,
    stage?: string,
  ): TaskArtifact {
    const task = this.requireTask(taskId);

    validateArtifactName(name);
    validateArtifactContent(content);

    const effectiveStage = stage && stage !== '_current_' ? stage : task.stage;

    const existing = this.db.queryOne<TaskArtifact>(
      'SELECT * FROM task_artifacts WHERE task_id = ? AND stage = ? AND name = ? ORDER BY version DESC LIMIT 1',
      [taskId, effectiveStage, name],
    );
    const version = existing ? existing.version + 1 : 1;
    const previousId = existing?.id ?? null;

    const result = this.db.run(
      `INSERT INTO task_artifacts (task_id, stage, name, content, created_by, version, previous_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [taskId, effectiveStage, name, content, createdBy, version, previousId],
    );
    const artifact = this.db.queryOne<TaskArtifact>('SELECT * FROM task_artifacts WHERE id = ?', [
      Number(result.lastInsertRowid),
    ])!;
    this.events.emit('artifact:created', { artifact });
    return artifact;
  }

  getArtifacts(taskId: number, stage?: string): TaskArtifact[] {
    this.requireTask(taskId);
    if (stage) {
      return this.db.queryAll<TaskArtifact>(
        'SELECT * FROM task_artifacts WHERE task_id = ? AND stage = ? ORDER BY created_at ASC',
        [taskId, stage],
      );
    }
    return this.db.queryAll<TaskArtifact>(
      'SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at ASC',
      [taskId],
    );
  }

  getArtifactCounts(): Record<number, number> {
    const rows = this.db.queryAll<{ task_id: number; cnt: number }>(
      'SELECT task_id, COUNT(*) as cnt FROM task_artifacts GROUP BY task_id',
    );
    const counts: Record<number, number> = {};
    for (const r of rows) counts[r.task_id] = r.cnt;
    return counts;
  }

  getArtifactCountsForTasks(taskIds: number[]): Record<number, number> {
    if (taskIds.length === 0) return {};
    const placeholders = taskIds.map(() => '?').join(',');
    const rows = this.db.queryAll<{ task_id: number; cnt: number }>(
      `SELECT task_id, COUNT(*) as cnt FROM task_artifacts WHERE task_id IN (${placeholders}) GROUP BY task_id`,
      taskIds,
    );
    const counts: Record<number, number> = {};
    for (const r of rows) counts[r.task_id] = r.cnt;
    return counts;
  }

  // ---- Subtasks ----

  getSubtasks(taskId: number): Task[] {
    this.requireTask(taskId);
    return this.db.queryAll<Task>(
      'SELECT * FROM tasks WHERE parent_id = ? ORDER BY priority DESC, created_at ASC',
      [taskId],
    );
  }

  getSubtaskProgress(taskId: number): { total: number; done: number } {
    const rows = this.db.queryAll<{ status: string; cnt: number }>(
      `SELECT status, COUNT(*) as cnt FROM tasks WHERE parent_id = ? GROUP BY status`,
      [taskId],
    );
    let total = 0;
    let done = 0;
    for (const r of rows) {
      total += r.cnt;
      if (r.status === 'completed') done += r.cnt;
    }
    return { total, done };
  }

  getSubtaskProgressForTasks(taskIds: number[]): Record<number, { total: number; done: number }> {
    if (taskIds.length === 0) return {};
    const placeholders = taskIds.map(() => '?').join(',');
    const rows = this.db.queryAll<{ parent_id: number; status: string; cnt: number }>(
      `SELECT parent_id, status, COUNT(*) as cnt FROM tasks WHERE parent_id IN (${placeholders}) GROUP BY parent_id, status`,
      taskIds,
    );
    const progress: Record<number, { total: number; done: number }> = {};
    for (const r of rows) {
      if (!progress[r.parent_id]) progress[r.parent_id] = { total: 0, done: 0 };
      progress[r.parent_id].total += r.cnt;
      if (r.status === 'completed') progress[r.parent_id].done += r.cnt;
    }
    return progress;
  }

  getAllSubtaskProgress(): Record<number, { total: number; done: number }> {
    const rows = this.db.queryAll<{ parent_id: number; status: string; cnt: number }>(
      `SELECT parent_id, status, COUNT(*) as cnt FROM tasks WHERE parent_id IS NOT NULL GROUP BY parent_id, status`,
    );
    const progress: Record<number, { total: number; done: number }> = {};
    for (const r of rows) {
      if (!progress[r.parent_id]) progress[r.parent_id] = { total: 0, done: 0 };
      progress[r.parent_id].total += r.cnt;
      if (r.status === 'completed') progress[r.parent_id].done += r.cnt;
    }
    return progress;
  }

  // ---- Search ----

  search(query: string, options?: { project?: string; limit?: number }): SearchResult[] {
    if (!query.trim()) return [];

    const sanitized = this.sanitizeFtsQuery(query);
    if (!sanitized) return [];

    let sql = `
      SELECT t.*, snippet(tasks_fts, 0, '<mark>', '</mark>', '...', 32) as snippet,
             rank
      FROM tasks_fts
      JOIN tasks t ON t.id = tasks_fts.rowid
      WHERE tasks_fts MATCH ?`;
    const params: unknown[] = [sanitized];

    if (options?.project) {
      sql += ' AND t.project = ?';
      params.push(options.project);
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(Math.min(options?.limit ?? 50, 200));

    const rows = this.db.queryAll<Task & { snippet: string; rank: number }>(sql, params);
    return rows.map((r) => ({
      task: r,
      snippet: r.snippet,
      rank: r.rank,
    }));
  }

  private sanitizeFtsQuery(query: string): string {
    const cleaned = query
      .replace(/["*^{}[\]:()\\/]/g, '')
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
      .trim();

    if (!cleaned) return '';

    return cleaned
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => '"' + w.replace(/"/g, '""') + '"')
      .join(' ');
  }

  // ---- Delete ----

  delete(taskId: number): void {
    const task = this.requireTask(taskId);
    this.db.run('DELETE FROM tasks WHERE id = ?', [taskId]);
    this.events.emit('task:deleted', { task });
  }

  // ---- Internal ----

  private requireTask(id: number): Task {
    const task = this.getById(id);
    if (!task) throw new NotFoundError('Task', id);
    return task;
  }

  private validateStage(stage: string, stages: string[]): void {
    if (!stages.includes(stage)) {
      throw new ValidationError(`Invalid stage: ${stage}. Valid: ${stages.join(', ')}`);
    }
  }

  private getAutoAssignee(stage: string, project?: string): string | null {
    if (!project) return null;
    const config = this.db.queryOne<PipelineConfig>(
      'SELECT * FROM pipeline_config WHERE project = ?',
      [project],
    );
    if (!config?.assignment_config) return null;
    try {
      const assignmentConfig = JSON.parse(config.assignment_config) as Record<
        string,
        { auto_assign?: string }
      >;
      return assignmentConfig[stage]?.auto_assign ?? null;
    } catch (err) {
      process.stderr.write(
        '[agent-tasks] getAutoAssignee JSON parse: ' +
          (err instanceof Error ? err.message : String(err)) +
          '\n',
      );
      return null;
    }
  }

  private checkStageGate(task: Task, inlineComment?: string): void {
    const gate = this.getGateConfig(task.project ?? undefined);
    if (!gate) return;

    const exemptStages = gate.exempt_stages ?? [];
    if (exemptStages.includes(task.stage)) return;

    if (gate.require_comment) {
      if (!inlineComment) {
        const commentCount = this.db.queryOne<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM task_comments WHERE task_id = ?`,
          [task.id],
        );
        if (!commentCount || commentCount.cnt === 0) {
          throw new ValidationError(
            `Stage gate: at least one comment required before advancing from '${task.stage}'. Use task_comment or pass comment param to task_advance.`,
          );
        }
      }
    }

    if (gate.require_artifact) {
      const artifactCount = this.db.queryOne<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM task_artifacts WHERE task_id = ? AND stage = ?`,
        [task.id, task.stage],
      );
      if (!artifactCount || artifactCount.cnt === 0) {
        throw new ValidationError(
          `Stage gate: at least one artifact required at stage '${task.stage}' before advancing. Use task_add_artifact.`,
        );
      }
    }

    const stageGate = gate.gates?.[task.stage];
    if (!stageGate) return;

    if (stageGate.require_comment) {
      if (!inlineComment) {
        const commentCount = this.db.queryOne<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM task_comments WHERE task_id = ?`,
          [task.id],
        );
        if (!commentCount || commentCount.cnt === 0) {
          throw new ValidationError(
            `Stage gate [${task.stage}]: comment required before advancing. Use task_comment or pass comment param to task_advance.`,
          );
        }
      }
    }

    if (stageGate.require_artifacts && stageGate.require_artifacts.length > 0) {
      const artifacts = this.db.queryAll<TaskArtifact>(
        `SELECT * FROM task_artifacts WHERE task_id = ? AND stage = ?`,
        [task.id, task.stage],
      );
      const artifactNames = new Set(artifacts.map((a) => a.name));
      const missing = stageGate.require_artifacts.filter((n) => !artifactNames.has(n));
      if (missing.length > 0) {
        throw new ValidationError(
          `Stage gate [${task.stage}]: required artifacts missing: ${missing.join(', ')}. Use task_add_artifact.`,
        );
      }
    }

    if (stageGate.require_min_artifacts !== undefined && stageGate.require_min_artifacts > 0) {
      const artifactCount = this.db.queryOne<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM task_artifacts WHERE task_id = ? AND stage = ?`,
        [task.id, task.stage],
      );
      if (!artifactCount || artifactCount.cnt < stageGate.require_min_artifacts) {
        throw new ValidationError(
          `Stage gate [${task.stage}]: at least ${stageGate.require_min_artifacts} artifact(s) required (found ${artifactCount?.cnt ?? 0}). Use task_add_artifact.`,
        );
      }
    }

    if (stageGate.require_approval) {
      const approved = this.db.queryOne<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM task_approvals WHERE task_id = ? AND stage = ? AND status = 'approved'`,
        [task.id, task.stage],
      );
      if (!approved || approved.cnt === 0) {
        throw new ValidationError(
          `Stage gate [${task.stage}]: approval required before advancing. Use task_approval(action: "request") + task_approval(action: "approve").`,
        );
      }
    }
  }

  private checkDependencies(taskId: number): void {
    const blockers = this.db.queryAll<Task>(
      `SELECT t.* FROM tasks t JOIN task_dependencies d ON t.id = d.depends_on
       WHERE d.task_id = ? AND d.relationship = 'blocks' AND t.status NOT IN ('completed', 'cancelled', 'failed')`,
      [taskId],
    );
    if (blockers.length > 0) {
      const names = blockers.map((b) => `#${b.id} "${b.title}" (${b.stage})`).join(', ');
      throw new ConflictError(`Blocked by incomplete dependencies: ${names}`);
    }
  }

  private wouldCreateCycle(taskId: number, dependsOn: number): boolean {
    const visited = new Set<number>();
    const stack = [dependsOn];

    while (stack.length) {
      const current = stack.pop()!;
      if (current === taskId) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const deps = this.db.queryAll<TaskDependency>(
        `SELECT * FROM task_dependencies WHERE task_id = ? AND relationship = 'blocks'`,
        [current],
      );
      for (const d of deps) stack.push(d.depends_on);
    }
    return false;
  }
}

// ---- Helpers ----

function syncStatusForStage(
  stage: string,
  stages: string[],
): 'pending' | 'in_progress' | 'completed' | 'cancelled' {
  if (stage === 'cancelled') return 'cancelled';
  const activeStages = stages.filter((s) => s !== 'cancelled');
  if (stage === activeStages[activeStages.length - 1]) return 'completed';
  if (stage === stages[0]) return 'pending';
  return 'in_progress';
}
