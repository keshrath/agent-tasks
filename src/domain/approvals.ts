// =============================================================================
// agent-tasks — Approval domain service
//
// Stage-gated approvals for pipeline advancement.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type { TaskApproval, PipelineConfig } from '../types.js';
import { NotFoundError, ConflictError, ValidationError } from '../types.js';
import { rejectNullBytes, rejectControlChars, MAX_AGENT_ID_LENGTH } from './validate.js';

export class ApprovalService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  request(taskId: number, stage: string, reviewer?: string): TaskApproval {
    const task = this.db.queryOne('SELECT id, project FROM tasks WHERE id = ?', [taskId]) as {
      id: number;
      project: string | null;
    } | null;
    if (!task) throw new NotFoundError('Task', taskId);

    if (reviewer) {
      this.validateReviewer(reviewer);
    }

    const existing = this.db.queryOne<TaskApproval>(
      `SELECT * FROM task_approvals WHERE task_id = ? AND stage = ? AND status = 'pending'`,
      [taskId, stage],
    );
    if (existing)
      throw new ConflictError(
        `Pending approval already exists for task ${taskId} at stage ${stage}.`,
      );

    const result = this.db.run(
      `INSERT INTO task_approvals (task_id, stage, reviewer) VALUES (?, ?, ?)`,
      [taskId, stage, reviewer ?? null],
    );

    const approval = this.db.queryOne<TaskApproval>('SELECT * FROM task_approvals WHERE id = ?', [
      Number(result.lastInsertRowid),
    ])!;

    this.events.emit('approval:requested', { approval });
    return approval;
  }

  approve(approvalId: number, reviewer: string, comment?: string): TaskApproval {
    this.validateReviewer(reviewer);
    return this.resolve(approvalId, 'approved', reviewer, comment);
  }

  reject(approvalId: number, reviewer: string, comment?: string): TaskApproval {
    this.validateReviewer(reviewer);
    if (!comment?.trim()) throw new ValidationError('Rejection requires a comment.');
    return this.resolve(approvalId, 'rejected', reviewer, comment);
  }

  getPending(reviewer?: string): TaskApproval[] {
    if (reviewer) {
      return this.db.queryAll<TaskApproval>(
        `SELECT * FROM task_approvals WHERE status = 'pending' AND (reviewer = ? OR reviewer IS NULL) ORDER BY requested_at ASC`,
        [reviewer],
      );
    }
    return this.db.queryAll<TaskApproval>(
      `SELECT * FROM task_approvals WHERE status = 'pending' ORDER BY requested_at ASC`,
    );
  }

  getForTask(taskId: number): TaskApproval[] {
    return this.db.queryAll<TaskApproval>(
      'SELECT * FROM task_approvals WHERE task_id = ? ORDER BY requested_at DESC',
      [taskId],
    );
  }

  isApprovalRequired(stage: string, project?: string): boolean {
    if (!project) return false;
    const config = this.db.queryOne<PipelineConfig>(
      'SELECT * FROM pipeline_config WHERE project = ?',
      [project],
    );
    if (!config?.approval_config) return false;
    try {
      const approvalConfig = JSON.parse(config.approval_config) as Record<
        string,
        { required?: boolean }
      >;
      return !!approvalConfig[stage]?.required;
    } catch {
      return false;
    }
  }

  hasPendingApproval(taskId: number, stage: string): boolean {
    const pending = this.db.queryOne<TaskApproval>(
      `SELECT id FROM task_approvals WHERE task_id = ? AND stage = ? AND status = 'pending'`,
      [taskId, stage],
    );
    return !!pending;
  }

  isApproved(taskId: number, stage: string): boolean {
    const approved = this.db.queryOne<TaskApproval>(
      `SELECT id FROM task_approvals WHERE task_id = ? AND stage = ? AND status = 'approved'`,
      [taskId, stage],
    );
    return !!approved;
  }

  private validateReviewer(reviewer: string): void {
    rejectNullBytes(reviewer, 'reviewer');
    rejectControlChars(reviewer, 'reviewer');
    if (reviewer.length > MAX_AGENT_ID_LENGTH) {
      throw new ValidationError(`Reviewer name too long (max ${MAX_AGENT_ID_LENGTH} chars).`);
    }
  }

  private resolve(
    approvalId: number,
    status: 'approved' | 'rejected',
    reviewer: string,
    comment?: string,
  ): TaskApproval {
    const approval = this.db.queryOne<TaskApproval>('SELECT * FROM task_approvals WHERE id = ?', [
      approvalId,
    ]);
    if (!approval) throw new NotFoundError('Approval', approvalId);
    if (approval.status !== 'pending') {
      throw new ConflictError(`Approval ${approvalId} is already ${approval.status}.`);
    }

    this.db.run(
      `UPDATE task_approvals SET status = ?, reviewer = ?, resolved_at = datetime('now'), comment = ? WHERE id = ?`,
      [status, reviewer, comment ?? null, approvalId],
    );

    const resolved = this.db.queryOne<TaskApproval>('SELECT * FROM task_approvals WHERE id = ?', [
      approvalId,
    ])!;

    this.events.emit(status === 'approved' ? 'approval:approved' : 'approval:rejected', {
      approval: resolved,
    });
    return resolved;
  }
}
