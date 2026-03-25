// =============================================================================
// agent-tasks — Comment domain service
//
// Threaded comments on tasks for async multi-agent discussion.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type { TaskComment } from '../types.js';
import { NotFoundError, ValidationError } from '../types.js';
import {
  MAX_COMMENT_LENGTH,
  MAX_AGENT_ID_LENGTH,
  rejectNullBytes,
  rejectControlChars,
} from './validate.js';

export class CommentService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  add(taskId: number, agentId: string, content: string, parentCommentId?: number): TaskComment {
    this.validateContent(content);
    rejectNullBytes(agentId, 'agent_id');
    rejectControlChars(agentId, 'agent_id');
    if (agentId.length > MAX_AGENT_ID_LENGTH) {
      throw new ValidationError(`Agent ID too long (max ${MAX_AGENT_ID_LENGTH} chars).`);
    }

    const task = this.db.queryOne('SELECT id FROM tasks WHERE id = ?', [taskId]);
    if (!task) throw new NotFoundError('Task', taskId);

    if (parentCommentId !== undefined) {
      const parent = this.db.queryOne<TaskComment>(
        'SELECT * FROM task_comments WHERE id = ? AND task_id = ?',
        [parentCommentId, taskId],
      );
      if (!parent) throw new NotFoundError('Parent comment', parentCommentId);
    }

    const result = this.db.run(
      `INSERT INTO task_comments (task_id, agent_id, content, parent_comment_id) VALUES (?, ?, ?, ?)`,
      [taskId, agentId, content.trim(), parentCommentId ?? null],
    );

    const comment = this.db.queryOne<TaskComment>('SELECT * FROM task_comments WHERE id = ?', [
      Number(result.lastInsertRowid),
    ])!;

    this.events.emit('comment:created', { comment });
    return comment;
  }

  list(taskId: number, limit = 100, offset = 0): TaskComment[] {
    return this.db.queryAll<TaskComment>(
      'SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
      [taskId, Math.min(limit, 500), offset],
    );
  }

  thread(commentId: number): TaskComment[] {
    const root = this.db.queryOne<TaskComment>('SELECT * FROM task_comments WHERE id = ?', [
      commentId,
    ]);
    if (!root) throw new NotFoundError('Comment', commentId);

    const rootId = root.parent_comment_id ?? root.id;
    return this.db.queryAll<TaskComment>(
      'SELECT * FROM task_comments WHERE id = ? OR parent_comment_id = ? ORDER BY created_at ASC',
      [rootId, rootId],
    );
  }

  countByTask(): Record<number, number> {
    const rows = this.db.queryAll<{ task_id: number; cnt: number }>(
      'SELECT task_id, COUNT(*) as cnt FROM task_comments GROUP BY task_id',
    );
    const counts: Record<number, number> = {};
    for (const r of rows) counts[r.task_id] = r.cnt;
    return counts;
  }

  private validateContent(content: string): void {
    rejectNullBytes(content, 'comment content');
    const trimmed = content.trim();
    if (!trimmed) throw new ValidationError('Comment content must not be empty.');
    if (trimmed.length > MAX_COMMENT_LENGTH) {
      throw new ValidationError(`Comment too long (max ${MAX_COMMENT_LENGTH} chars).`);
    }
  }
}
