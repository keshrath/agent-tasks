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
  SearchResult,
} from '../types.js';
import { NotFoundError, ConflictError, ValidationError } from '../types.js';
import {
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_RESULT_LENGTH,
  MAX_ARTIFACT_CONTENT_LENGTH,
  MAX_ARTIFACT_NAME_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  MAX_TAG_LENGTH,
  MAX_TAGS_COUNT,
  MAX_STAGE_NAME_LENGTH,
  MAX_STAGES_COUNT,
  MAX_LIST_LIMIT,
  rejectNullBytes,
  rejectControlChars,
} from './validate.js';

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
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  // ---- Pipeline Config ----

  getPipelineStages(project?: string): string[] {
    if (project) {
      const config = this.db.queryOne<PipelineConfig>(
        'SELECT * FROM pipeline_config WHERE project = ?',
        [project],
      );
      if (config) {
        try {
          return JSON.parse(config.stages);
        } catch {
          /* fall through */
        }
      }
    }
    return [...DEFAULT_STAGES];
  }

  setPipelineConfig(project: string, stages: string[]): PipelineConfig {
    this.validateProjectName(project);
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
    this.events.emit('pipeline:configured', { project, stages });
    return this.db.queryOne<PipelineConfig>('SELECT * FROM pipeline_config WHERE project = ?', [
      project,
    ])!;
  }

  // ---- CRUD ----

  create(input: TaskCreateInput, createdBy: string): Task {
    this.validateTitle(input.title);
    if (input.description !== undefined) this.validateDescription(input.description);
    if (input.project !== undefined) this.validateProjectName(input.project);
    if (input.tags !== undefined) this.validateTags(input.tags);
    if (input.assign_to !== undefined) this.validateAssignee(input.assign_to);
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

    if (updates.title !== undefined) this.validateTitle(updates.title);
    if (updates.description !== undefined) this.validateDescription(updates.description);
    if (updates.project !== undefined) this.validateProjectName(updates.project);
    if (updates.tags !== undefined) this.validateTags(updates.tags);
    if (updates.assigned_to !== undefined && updates.assigned_to !== '') {
      this.validateAssignee(updates.assigned_to);
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

  // ---- Claiming ----

  claim(taskId: number, claimerName: string): Task {
    this.validateAssignee(claimerName);

    return this.db.transaction(() => {
      const task = this.requireTask(taskId);
      if (task.status !== 'pending') {
        throw new ConflictError(`Task ${taskId} is not pending (status: ${task.status}).`);
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

  // ---- Completion / Failure / Cancellation ----

  complete(taskId: number, result: string): Task {
    this.validateResult(result);

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
      const completed = this.getById(taskId)!;
      this.events.emit('task:completed', { task: completed });
      return completed;
    });
  }

  fail(taskId: number, result: string): Task {
    this.validateResult(result);

    const res = this.db.run(
      `UPDATE tasks SET status = 'failed', result = ?, updated_at = datetime('now') WHERE id = ? AND status = 'in_progress'`,
      [result, taskId],
    );
    if (res.changes === 0) {
      const task = this.getById(taskId);
      if (!task) throw new NotFoundError('Task', taskId);
      throw new ConflictError(`Task ${taskId} not in progress (status: ${task.status}).`);
    }
    const failed = this.getById(taskId)!;
    this.events.emit('task:failed', { task: failed });
    return failed;
  }

  cancel(taskId: number, reason: string): Task {
    this.validateResult(reason);

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

  advance(taskId: number, toStage?: string): Task {
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
        this.validateResult(reason);
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

  next(project?: string, stage?: string): Task | null {
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
      WHERE d.task_id = t.id AND d.relationship = 'blocks' AND dep.stage NOT IN ('done', 'cancelled')
    )`;

    sql += ' ORDER BY t.priority DESC, t.created_at ASC LIMIT 1';

    return this.db.queryOne<Task>(sql, params);
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

  // ---- Artifacts ----

  addArtifact(
    taskId: number,
    name: string,
    content: string,
    createdBy: string,
    stage?: string,
  ): TaskArtifact {
    const task = this.requireTask(taskId);

    this.validateArtifactName(name);
    this.validateArtifactContent(content);

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
      .map((w) => `"${w}"`)
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
    } catch {
      return null;
    }
  }

  private validateTitle(title: string): void {
    rejectNullBytes(title, 'title');
    rejectControlChars(title, 'title');
    const trimmed = title.trim();
    if (!trimmed) throw new ValidationError('Title must not be empty.');
    if (trimmed.length > MAX_TITLE_LENGTH) {
      throw new ValidationError(`Title too long (max ${MAX_TITLE_LENGTH} chars).`);
    }
  }

  private validateDescription(desc: string): void {
    rejectNullBytes(desc, 'description');
    if (desc.length > MAX_DESCRIPTION_LENGTH) {
      throw new ValidationError(`Description too long (max ${MAX_DESCRIPTION_LENGTH} chars).`);
    }
  }

  private validateResult(result: string): void {
    rejectNullBytes(result, 'result');
    if (result.length > MAX_RESULT_LENGTH) {
      throw new ValidationError(`Result too long (max ${MAX_RESULT_LENGTH} chars).`);
    }
  }

  private validateProjectName(project: string): void {
    rejectNullBytes(project, 'project');
    rejectControlChars(project, 'project');
    if (project.length > MAX_PROJECT_NAME_LENGTH) {
      throw new ValidationError(`Project name too long (max ${MAX_PROJECT_NAME_LENGTH} chars).`);
    }
  }

  private validateAssignee(name: string): void {
    rejectNullBytes(name, 'assign_to');
    rejectControlChars(name, 'assign_to');
    if (!name.trim()) throw new ValidationError('Assignee name must not be empty.');
  }

  private validateTags(tags: string[]): void {
    if (tags.length > MAX_TAGS_COUNT) {
      throw new ValidationError(`Too many tags (max ${MAX_TAGS_COUNT}).`);
    }
    for (const tag of tags) {
      rejectNullBytes(tag, 'tag');
      rejectControlChars(tag, 'tag');
      if (tag.length > MAX_TAG_LENGTH) {
        throw new ValidationError(`Tag too long: "${tag}" (max ${MAX_TAG_LENGTH} chars).`);
      }
    }
  }

  private validateArtifactName(name: string): void {
    rejectNullBytes(name, 'artifact name');
    rejectControlChars(name, 'artifact name');
    if (!name.trim()) throw new ValidationError('Artifact name must not be empty.');
    if (name.length > MAX_ARTIFACT_NAME_LENGTH) {
      throw new ValidationError(`Artifact name too long (max ${MAX_ARTIFACT_NAME_LENGTH} chars).`);
    }
  }

  private validateArtifactContent(content: string): void {
    rejectNullBytes(content, 'artifact content');
    if (content.length > MAX_ARTIFACT_CONTENT_LENGTH) {
      throw new ValidationError(
        `Artifact content too long (max ${MAX_ARTIFACT_CONTENT_LENGTH} chars).`,
      );
    }
  }

  private checkDependencies(taskId: number): void {
    const blockers = this.db.queryAll<Task>(
      `SELECT t.* FROM tasks t JOIN task_dependencies d ON t.id = d.depends_on
       WHERE d.task_id = ? AND d.relationship = 'blocks' AND t.stage NOT IN ('done', 'cancelled')`,
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
        'SELECT * FROM task_dependencies WHERE task_id = ?',
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
  if (stage === 'done') return 'completed';
  if (stage === stages[0]) return 'pending';
  return 'in_progress';
}
