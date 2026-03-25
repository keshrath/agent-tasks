// =============================================================================
// agent-tasks — Collaborator domain service
//
// Multiple agents can collaborate on a single task with defined roles.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type { CollaboratorRole, TaskCollaborator } from '../types.js';
import { NotFoundError, ValidationError, ConflictError } from '../types.js';
import { rejectNullBytes, rejectControlChars, MAX_AGENT_ID_LENGTH } from './validate.js';

const VALID_ROLES: readonly CollaboratorRole[] = ['collaborator', 'reviewer', 'watcher'];

export class CollaboratorService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  add(taskId: number, agentId: string, role: CollaboratorRole = 'collaborator'): TaskCollaborator {
    this.validateAgent(agentId);
    if (!VALID_ROLES.includes(role)) {
      throw new ValidationError(`Invalid role: ${role}. Valid: ${VALID_ROLES.join(', ')}`);
    }

    const task = this.db.queryOne('SELECT id FROM tasks WHERE id = ?', [taskId]);
    if (!task) throw new NotFoundError('Task', taskId);

    try {
      this.db.run(`INSERT INTO task_collaborators (task_id, agent_id, role) VALUES (?, ?, ?)`, [
        taskId,
        agentId,
        role,
      ]);
    } catch {
      throw new ConflictError(`Agent ${agentId} is already a collaborator on task ${taskId}.`);
    }

    const collab = this.db.queryOne<TaskCollaborator>(
      'SELECT * FROM task_collaborators WHERE task_id = ? AND agent_id = ?',
      [taskId, agentId],
    )!;

    this.events.emit('collaborator:added', { task_id: taskId, agent_id: agentId, role });
    return collab;
  }

  remove(taskId: number, agentId: string): void {
    const result = this.db.run(
      'DELETE FROM task_collaborators WHERE task_id = ? AND agent_id = ?',
      [taskId, agentId],
    );
    if (result.changes === 0) {
      throw new NotFoundError('Collaborator', `${agentId} on task ${taskId}`);
    }
    this.events.emit('collaborator:removed', { task_id: taskId, agent_id: agentId });
  }

  list(taskId: number): TaskCollaborator[] {
    return this.db.queryAll<TaskCollaborator>(
      'SELECT * FROM task_collaborators WHERE task_id = ? ORDER BY added_at ASC',
      [taskId],
    );
  }

  listAllByTask(): Record<number, TaskCollaborator[]> {
    const rows = this.db.queryAll<TaskCollaborator>(
      'SELECT * FROM task_collaborators ORDER BY added_at ASC',
    );
    const result: Record<number, TaskCollaborator[]> = {};
    for (const r of rows) {
      if (!result[r.task_id]) result[r.task_id] = [];
      result[r.task_id].push(r);
    }
    return result;
  }

  getTasksForAgent(agentId: string): number[] {
    const rows = this.db.queryAll<{ task_id: number }>(
      'SELECT task_id FROM task_collaborators WHERE agent_id = ?',
      [agentId],
    );
    return rows.map((r) => r.task_id);
  }

  private validateAgent(agentId: string): void {
    rejectNullBytes(agentId, 'agent_id');
    rejectControlChars(agentId, 'agent_id');
    if (!agentId.trim()) throw new ValidationError('Agent ID must not be empty.');
    if (agentId.length > MAX_AGENT_ID_LENGTH) {
      throw new ValidationError(`Agent ID too long (max ${MAX_AGENT_ID_LENGTH} chars).`);
    }
  }
}
