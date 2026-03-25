import { queryAll, queryOne, run, transaction } from './db.js';
import { eventBus } from './event-bus.js';
import { getCurrentSession } from './session.js';
import type { Task, TaskArtifact, TaskDependency, PipelineConfig } from './types.js';

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

const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'] as const;

// ---- Input Validation ----

function validateStage(stage: string, stages: string[]): void {
  if (!stages.includes(stage)) {
    throw new Error(`Invalid stage: ${stage}. Valid: ${stages.join(', ')}`);
  }
}

function validatePositiveInt(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

// ---- Pipeline Config ----

export function getPipelineStages(project?: string): string[] {
  if (project) {
    const config = queryOne<PipelineConfig>('SELECT * FROM pipeline_config WHERE project = ?', [
      project,
    ]);
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

export function setPipelineConfig(project: string, stages: string[]): PipelineConfig {
  if (!stages.length) throw new Error('Stages array cannot be empty.');
  const seen = new Set<string>();
  for (const s of stages) {
    if (seen.has(s)) throw new Error(`Duplicate stage: ${s}`);
    seen.add(s);
  }

  const json = JSON.stringify(stages);
  run(
    `INSERT INTO pipeline_config (project, stages, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(project) DO UPDATE SET stages = ?, updated_at = datetime('now')`,
    [project, json, json],
  );
  return queryOne<PipelineConfig>('SELECT * FROM pipeline_config WHERE project = ?', [project])!;
}

// ---- Stage/Status Sync ----

function syncStatusForStage(
  stage: string,
  stages: string[],
): 'pending' | 'in_progress' | 'completed' | 'cancelled' {
  if (stage === 'cancelled') return 'cancelled';
  if (stage === 'done') return 'completed';
  if (stage === stages[0]) return 'pending';
  return 'in_progress';
}

// ---- CRUD ----

export function createTask(
  title: string,
  description?: string,
  assignTo?: string,
  stage?: string,
  priority?: number,
  project?: string,
  tags?: string[],
): Task {
  const session = getCurrentSession();
  const createdBy = session?.name || 'system';

  const stages = getPipelineStages(project);
  const effectiveStage = stage || stages[0];
  validateStage(effectiveStage, stages);

  const status = syncStatusForStage(effectiveStage, stages);

  const result = run(
    `INSERT INTO tasks (title, description, created_by, assigned_to, status, stage, priority, project, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      title,
      description ?? null,
      createdBy,
      assignTo ?? null,
      status,
      effectiveStage,
      priority ?? 0,
      project ?? null,
      tags ? JSON.stringify(tags) : null,
    ],
  );

  eventBus.emit('task:create');
  return getTask(Number(result.lastInsertRowid))!;
}

export function updateTask(
  taskId: number,
  updates: {
    title?: string;
    description?: string;
    priority?: number;
    project?: string;
    tags?: string[];
    assigned_to?: string;
  },
): Task {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);

  const sets: string[] = [];
  const params: unknown[] = [];

  if (updates.title !== undefined) {
    sets.push('title = ?');
    params.push(updates.title);
  }
  if (updates.description !== undefined) {
    sets.push('description = ?');
    params.push(updates.description);
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

  if (!sets.length) throw new Error('No fields to update.');

  sets.push("updated_at = datetime('now')");
  params.push(taskId);

  run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params);
  eventBus.emit('task:update');
  return getTask(taskId)!;
}

export function listTasks(
  status?: string,
  assignedTo?: string,
  stage?: string,
  project?: string,
  limit?: number,
  offset?: number,
): Task[] {
  validatePositiveInt(limit, 'limit');
  validatePositiveInt(offset, 'offset');

  if (status && !VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
    throw new Error(`Invalid status: ${status}. Valid: ${VALID_STATUSES.join(', ')}`);
  }
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params: unknown[] = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (assignedTo) {
    sql += ' AND assigned_to = ?';
    params.push(assignedTo);
  }
  if (stage) {
    sql += ' AND stage = ?';
    params.push(stage);
  }
  if (project) {
    sql += ' AND project = ?';
    params.push(project);
  }
  sql += ' ORDER BY priority DESC, created_at DESC';

  if (limit && limit > 0) {
    sql += ' LIMIT ?';
    params.push(Math.min(limit, 500));
    if (offset && offset > 0) {
      sql += ' OFFSET ?';
      params.push(offset);
    }
  }

  return queryAll<Task>(sql, params);
}

export function claimTask(taskId: number, claimerName?: string): Task {
  const session = getCurrentSession();
  const name = claimerName || session?.name;
  if (!name) throw new Error('No session or claimer name provided.');

  return transaction(() => {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found.`);
    if (task.status !== 'pending')
      throw new Error(`Task ${taskId} is not pending (status: ${task.status}).`);

    const stages = getPipelineStages(task.project ?? undefined);
    const firstStage = stages[0];
    const nextStage = stages.length > 1 ? stages[1] : firstStage;
    const newStage = task.stage === firstStage ? nextStage : task.stage;
    const newStatus = syncStatusForStage(newStage, stages);

    run(
      `UPDATE tasks SET status = ?, stage = ?, assigned_to = ?, updated_at = datetime('now') WHERE id = ?`,
      [newStatus, newStage, name, taskId],
    );
    eventBus.emit('task:update');
    return getTask(taskId)!;
  });
}

export function completeTask(taskId: number, result: string): Task {
  return transaction(() => {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found.`);
    if (task.status !== 'in_progress') throw new Error(`Task ${taskId} not in progress.`);

    const stages = getPipelineStages(task.project ?? undefined);
    const doneStage = stages[stages.length - 1];

    run(
      `UPDATE tasks SET status = 'completed', stage = ?, result = ?, updated_at = datetime('now') WHERE id = ?`,
      [doneStage, result, taskId],
    );
    eventBus.emit('task:update');
    return getTask(taskId)!;
  });
}

export function failTask(taskId: number, result: string): Task {
  const res = run(
    `UPDATE tasks SET status = 'failed', result = ?, updated_at = datetime('now') WHERE id = ? AND status = 'in_progress'`,
    [result, taskId],
  );

  if (res.changes === 0) throw new Error(`Task ${taskId} not found or not in progress.`);
  eventBus.emit('task:update');
  return getTask(taskId)!;
}

export function cancelTask(taskId: number, reason: string): Task {
  return transaction(() => {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found.`);
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new Error(`Task ${taskId} is already ${task.status}.`);
    }

    run(
      `UPDATE tasks SET status = 'cancelled', stage = 'cancelled', result = ?, updated_at = datetime('now') WHERE id = ?`,
      [reason, taskId],
    );
    eventBus.emit('task:update');
    return getTask(taskId)!;
  });
}

// ---- Pipeline Advancement ----

export function advanceTask(taskId: number, toStage?: string): Task {
  return transaction(() => {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found.`);
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(`Task ${taskId} is ${task.status} — cannot advance.`);
    }

    const stages = getPipelineStages(task.project ?? undefined);
    const activeStages = stages.filter((s) => s !== 'cancelled');
    const currentIdx = activeStages.indexOf(task.stage);
    if (currentIdx === -1) throw new Error(`Task stage '${task.stage}' not in pipeline.`);

    let targetIdx: number;
    if (toStage) {
      if (toStage === 'cancelled') throw new Error(`Use task_cancel to cancel a task.`);
      targetIdx = activeStages.indexOf(toStage);
      if (targetIdx === -1)
        throw new Error(`Invalid target stage: ${toStage}. Valid: ${activeStages.join(', ')}`);
      if (targetIdx <= currentIdx)
        throw new Error(
          `Target stage '${toStage}' is not ahead of current stage '${task.stage}'. Use task_regress to move backward.`,
        );
    } else {
      targetIdx = currentIdx + 1;
      if (targetIdx >= activeStages.length)
        throw new Error(`Task is already at the final stage: ${task.stage}.`);
    }

    checkDependencies(taskId);

    const newStage = activeStages[targetIdx];
    const newStatus = syncStatusForStage(newStage, activeStages);

    run(`UPDATE tasks SET stage = ?, status = ?, updated_at = datetime('now') WHERE id = ?`, [
      newStage,
      newStatus,
      taskId,
    ]);
    eventBus.emit('task:update');
    return getTask(taskId)!;
  });
}

export function regressTask(taskId: number, toStage: string, reason?: string): Task {
  return transaction(() => {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found.`);

    const stages = getPipelineStages(task.project ?? undefined);
    const currentIdx = stages.indexOf(task.stage);
    const targetIdx = stages.indexOf(toStage);
    if (targetIdx === -1)
      throw new Error(`Invalid target stage: ${toStage}. Valid: ${stages.join(', ')}`);
    if (targetIdx >= currentIdx)
      throw new Error(`Target stage '${toStage}' is not before current stage '${task.stage}'.`);

    const newStatus = syncStatusForStage(toStage, stages);

    run(`UPDATE tasks SET stage = ?, status = ?, updated_at = datetime('now') WHERE id = ?`, [
      toStage,
      newStatus,
      taskId,
    ]);

    if (reason) {
      const session = getCurrentSession();
      const createdBy = session?.name || 'system';
      run(
        `INSERT INTO task_artifacts (task_id, stage, name, content, created_by) VALUES (?, ?, ?, ?, ?)`,
        [
          taskId,
          task.stage,
          'rejection',
          `Regressed from ${task.stage} to ${toStage}: ${reason}`,
          createdBy,
        ],
      );
    }

    eventBus.emit('task:update');
    return getTask(taskId)!;
  });
}

// ---- Next Task (agent picks work) ----

export function nextTask(project?: string, stage?: string): Task | null {
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
    WHERE d.task_id = t.id AND dep.stage NOT IN ('done', 'cancelled')
  )`;

  sql += ' ORDER BY t.priority DESC, t.created_at ASC LIMIT 1';

  return queryOne<Task>(sql, params);
}

// ---- Dependencies ----

export function addDependency(taskId: number, dependsOn: number): void {
  if (taskId === dependsOn) throw new Error('A task cannot depend on itself.');

  const task = getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  const dep = getTask(dependsOn);
  if (!dep) throw new Error(`Dependency task ${dependsOn} not found.`);

  if (wouldCreateCycle(taskId, dependsOn)) {
    throw new Error(`Adding dependency ${taskId} → ${dependsOn} would create a cycle.`);
  }

  try {
    run('INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)', [taskId, dependsOn]);
  } catch {
    throw new Error(`Dependency ${taskId} → ${dependsOn} already exists.`);
  }
  eventBus.emit('task:update');
}

export function removeDependency(taskId: number, dependsOn: number): void {
  const result = run('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on = ?', [
    taskId,
    dependsOn,
  ]);
  if (result.changes === 0) throw new Error(`Dependency ${taskId} → ${dependsOn} not found.`);
  eventBus.emit('task:update');
}

export function getTaskDependencies(taskId: number): { blockers: Task[]; blocking: Task[] } {
  return {
    blockers: queryAll<Task>(
      'SELECT t.* FROM tasks t JOIN task_dependencies d ON t.id = d.depends_on WHERE d.task_id = ?',
      [taskId],
    ),
    blocking: queryAll<Task>(
      'SELECT t.* FROM tasks t JOIN task_dependencies d ON t.id = d.task_id WHERE d.depends_on = ?',
      [taskId],
    ),
  };
}

export function getAllDependencies(): TaskDependency[] {
  return queryAll<TaskDependency>('SELECT * FROM task_dependencies');
}

function wouldCreateCycle(taskId: number, dependsOn: number): boolean {
  const visited = new Set<number>();
  const stack = [dependsOn];

  while (stack.length) {
    const current = stack.pop()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    // Follow: what does `current` depend on?
    const deps = queryAll<TaskDependency>('SELECT * FROM task_dependencies WHERE task_id = ?', [
      current,
    ]);
    for (const d of deps) stack.push(d.depends_on);
  }
  return false;
}

function checkDependencies(taskId: number): void {
  const blockers = queryAll<Task>(
    `SELECT t.* FROM tasks t JOIN task_dependencies d ON t.id = d.depends_on
     WHERE d.task_id = ? AND t.stage NOT IN ('done', 'cancelled')`,
    [taskId],
  );
  if (blockers.length > 0) {
    const names = blockers.map((b) => `#${b.id} "${b.title}" (${b.stage})`).join(', ');
    throw new Error(`Blocked by incomplete dependencies: ${names}`);
  }
}

// ---- Artifacts ----

export function addArtifact(
  taskId: number,
  stage: string,
  name: string,
  content: string,
): TaskArtifact {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);

  if (!stage || stage === '_current_') stage = task.stage;

  const session = getCurrentSession();
  const createdBy = session?.name || 'system';

  const result = run(
    `INSERT INTO task_artifacts (task_id, stage, name, content, created_by) VALUES (?, ?, ?, ?, ?)`,
    [taskId, stage, name, content, createdBy],
  );
  eventBus.emit('task:update');
  return queryOne<TaskArtifact>('SELECT * FROM task_artifacts WHERE id = ?', [
    Number(result.lastInsertRowid),
  ])!;
}

export function getArtifacts(taskId: number, stage?: string): TaskArtifact[] {
  if (stage) {
    return queryAll<TaskArtifact>(
      'SELECT * FROM task_artifacts WHERE task_id = ? AND stage = ? ORDER BY created_at ASC',
      [taskId, stage],
    );
  }
  return queryAll<TaskArtifact>(
    'SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at ASC',
    [taskId],
  );
}

export function getArtifactCounts(): Record<number, number> {
  const rows = queryAll<{ task_id: number; cnt: number }>(
    'SELECT task_id, COUNT(*) as cnt FROM task_artifacts GROUP BY task_id',
  );
  const counts: Record<number, number> = {};
  for (const r of rows) counts[r.task_id] = r.cnt;
  return counts;
}

// ---- Internal ----

function getTask(id: number): Task | null {
  return queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
}
