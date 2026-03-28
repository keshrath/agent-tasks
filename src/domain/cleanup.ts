// Cleanup service — purges old completed/cancelled tasks and stale data
import type { Db } from '../storage/database.js';
import type { AgentBridge } from './agent-bridge.js';
import type { Task } from '../types.js';

export class CleanupService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly retentionDays: number = 30,
    private readonly agentBridge?: AgentBridge,
  ) {}

  start(): void {
    // Run cleanup every hour
    this.timer = setInterval(() => this.run(), 60 * 60 * 1000);
    this.timer.unref();
    // Run once on start (delayed 10s)
    setTimeout(() => {
      this.run();
      this.failStaleAgentTasks().catch(() => {});
    }, 10_000).unref();
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
    // Purge completed/cancelled by status OR tasks in done/cancelled stage
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

  async failStaleAgentTasks(
    timeoutMinutes: number = 30,
  ): Promise<{ failed: Task[]; checked: number }> {
    if (!this.agentBridge) {
      return { failed: [], checked: 0 };
    }

    const inProgressTasks = this.db.queryAll<Task>(
      `SELECT * FROM tasks WHERE status = 'in_progress' AND assigned_to IS NOT NULL`,
    );

    if (inProgressTasks.length === 0) {
      return { failed: [], checked: 0 };
    }

    const agentNames = [...new Set(inProgressTasks.map((t) => t.assigned_to!))];
    let agents: Array<{ name: string; status: string; last_heartbeat?: string }>;
    try {
      agents = (await this.agentBridge.fetchAgents()) as Array<{
        name: string;
        status: string;
        last_heartbeat?: string;
      }>;
    } catch {
      return { failed: [], checked: agentNames.length };
    }

    if (!Array.isArray(agents) || agents.length === 0) {
      return { failed: [], checked: agentNames.length };
    }

    const agentMap = new Map<string, { status: string; last_heartbeat?: string }>();
    for (const a of agents) {
      if (a.name) agentMap.set(a.name, a);
    }

    const cutoff = Date.now() - timeoutMinutes * 60 * 1000;
    const staleAgents = new Set<string>();

    for (const name of agentNames) {
      const agent = agentMap.get(name);
      if (!agent) {
        staleAgents.add(name);
        continue;
      }
      if (agent.status === 'offline') {
        staleAgents.add(name);
        continue;
      }
      if (agent.last_heartbeat) {
        const hbTime = new Date(agent.last_heartbeat).getTime();
        if (hbTime < cutoff) {
          staleAgents.add(name);
        }
      }
    }

    const failed: Task[] = [];
    for (const task of inProgressTasks) {
      if (!staleAgents.has(task.assigned_to!)) continue;
      const agent = agentMap.get(task.assigned_to!);
      const reason = agent
        ? `Auto-failed: agent "${task.assigned_to}" has not heartbeated for ${timeoutMinutes} minutes`
        : `Auto-failed: agent "${task.assigned_to}" is no longer registered`;
      try {
        this.db.run(
          `UPDATE tasks SET status = 'failed', result = ?, updated_at = datetime('now') WHERE id = ?`,
          [reason, task.id],
        );
        const updated = this.db.queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
        if (updated) failed.push(updated);
      } catch {
        /* skip tasks that can't be failed */
      }
    }

    return { failed, checked: agentNames.length };
  }

  purgeEverything(): {
    purgedTasks: number;
    purgedComments: number;
    purgedArtifacts: number;
    purgedApprovals: number;
  } {
    // Nuclear option — delete ALL tasks regardless of status/stage
    const tasks = this.db.run(`DELETE FROM tasks`);
    const comments = this.db.run(`DELETE FROM task_comments`);
    const artifacts = this.db.run(`DELETE FROM task_artifacts`);
    const approvals = this.db.run(`DELETE FROM task_approvals`);
    return {
      purgedTasks: tasks.changes,
      purgedComments: comments.changes,
      purgedArtifacts: artifacts.changes,
      purgedApprovals: approvals.changes,
    };
  }
}
