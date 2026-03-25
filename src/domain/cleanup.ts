// Cleanup service — purges old completed/cancelled tasks and stale data
import type { Db } from '../storage/database.js';

export class CleanupService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly retentionDays: number = 30,
  ) {}

  start(): void {
    // Run cleanup every hour
    this.timer = setInterval(() => this.run(), 60 * 60 * 1000);
    this.timer.unref();
    // Run once on start (delayed 10s)
    setTimeout(() => this.run(), 10_000).unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  run(): {
    purgedTasks: number;
    purgedComments: number;
    purgedArtifacts: number;
    purgedApprovals: number;
  } {
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const tasks = this.db.run(
      `DELETE FROM tasks WHERE status IN ('completed', 'cancelled') AND updated_at < ?`,
      [cutoff],
    );

    // Orphaned comments (task deleted via CASCADE should handle this, but just in case)
    const comments = this.db.run(
      `DELETE FROM task_comments WHERE task_id NOT IN (SELECT id FROM tasks)`,
    );

    // Orphaned artifacts (defensive — CASCADE should handle this)
    const artifacts = this.db.run(
      `DELETE FROM task_artifacts WHERE task_id NOT IN (SELECT id FROM tasks)`,
    );

    // Resolved approvals older than retention
    const approvals = this.db.run(
      `DELETE FROM task_approvals WHERE status != 'pending' AND resolved_at < ?`,
      [cutoff],
    );

    return {
      purgedTasks: tasks.changes,
      purgedComments: comments.changes,
      purgedArtifacts: artifacts.changes,
      purgedApprovals: approvals.changes,
    };
  }

  purgeAll(): {
    purgedTasks: number;
    purgedComments: number;
    purgedArtifacts: number;
    purgedApprovals: number;
  } {
    const tasks = this.db.run(`DELETE FROM tasks WHERE status IN ('completed', 'cancelled')`);
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
}
