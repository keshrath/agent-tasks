// =============================================================================
// agent-tasks — Cleanup service
//
// Hourly retention sweep (run()), the unassigned-orphan reaper, and
// purgeAll() limited to completed and cancelled tasks. Claimed tasks whose
// session is gone are HolderService's.
// =============================================================================

import type { Db } from '../storage/database.js';
const ORPHAN_TIMEOUT_MINUTES = parseInt(
  process.env.AGENT_TASKS_ORPHAN_TIMEOUT_MINUTES ?? '360', // 6 hours
  10,
);
const COMPLETED_RETENTION_DAYS = parseFloat(
  process.env.AGENT_TASKS_COMPLETED_RETENTION_DAYS ?? '7',
);
const CANCELLED_RETENTION_DAYS = parseFloat(
  process.env.AGENT_TASKS_CANCELLED_RETENTION_DAYS ?? '1',
);
const FAILED_RETENTION_DAYS = parseFloat(process.env.AGENT_TASKS_FAILED_RETENTION_DAYS ?? '7');

export interface TasksCleanupStats extends Record<string, number> {
  purgedTasks: number;
  purgedComments: number;
  purgedArtifacts: number;
  purgedApprovals: number;
}

const RUN_EVERY_MS = 60 * 60 * 1000;

export class CleanupService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly retentionDays: number = 30,
  ) {}

  start(): void {
    if (this.timer) return;
    this.run();
    this.timer = setInterval(() => {
      try {
        this.run();
      } catch (err) {
        process.stderr.write(
          `[agent-tasks] Cleanup error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }, RUN_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  run(): TasksCleanupStats {
    const isoCutoff = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);

    const completedCutoff = isoCutoff(COMPLETED_RETENTION_DAYS);
    const cancelledCutoff = isoCutoff(CANCELLED_RETENTION_DAYS);
    const failedCutoff = isoCutoff(FAILED_RETENTION_DAYS);
    const approvalCutoff = isoCutoff(this.retentionDays);

    this.cancelOrphanedTasks();

    const tasks = this.db.run(
      `DELETE FROM tasks
        WHERE (status = 'completed' AND updated_at < ?)
           OR (status = 'cancelled' AND updated_at < ?)
           OR (status = 'failed'    AND updated_at < ?)`,
      [completedCutoff, cancelledCutoff, failedCutoff],
    );

    const comments = this.db.run(
      `DELETE FROM task_comments WHERE task_id NOT IN (SELECT id FROM tasks)`,
    );

    const artifacts = this.db.run(
      `DELETE FROM task_artifacts WHERE task_id NOT IN (SELECT id FROM tasks)`,
    );

    const approvals = this.db.run(
      `DELETE FROM task_approvals WHERE status != 'pending' AND resolved_at < ?`,
      [approvalCutoff],
    );

    return {
      purgedTasks: tasks.changes,
      purgedComments: comments.changes,
      purgedArtifacts: artifacts.changes,
      purgedApprovals: approvals.changes,
    };
  }

  purgeAll(): TasksCleanupStats {
    const tasks = this.db.run(
      `DELETE FROM tasks WHERE status IN ('completed', 'cancelled') OR stage IN ('done', 'cancelled')`,
    );
    const comments = this.db.run(
      `DELETE FROM task_comments WHERE task_id NOT IN (SELECT id FROM tasks)`,
    );
    const artifacts = this.db.run(
      `DELETE FROM task_artifacts WHERE task_id NOT IN (SELECT id FROM tasks)`,
    );
    const approvals = this.db.run(`DELETE FROM task_approvals WHERE status != 'pending'`);
    return {
      purgedTasks: tasks.changes,
      purgedComments: comments.changes,
      purgedArtifacts: artifacts.changes,
      purgedApprovals: approvals.changes,
    };
  }

  /**
   * Cancel tasks that are stuck in_progress with no assignee for longer than
   * ORPHAN_TIMEOUT_MINUTES: nobody works on them and no holder fails them.
   * Returns the number of tasks cancelled.
   */
  cancelOrphanedTasks(timeoutMinutes: number = ORPHAN_TIMEOUT_MINUTES): number {
    const result = this.db.run(
      `UPDATE tasks
          SET status = 'cancelled',
              result = 'Auto-cancelled: in_progress with no assignee for ' || ? || ' minutes (orphan reaper)',
              updated_at = datetime('now')
        WHERE status = 'in_progress'
          AND assigned_to IS NULL
          AND updated_at < datetime('now', '-' || ? || ' minutes')`,
      [timeoutMinutes, timeoutMinutes],
    );
    return result.changes;
  }
}
