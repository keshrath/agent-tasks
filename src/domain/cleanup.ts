// =============================================================================
// agent-tasks — Cleanup service
//
// Extends agent-common's CleanupService base for timer scheduling. Adds:
//   - agent-bridge integration (fails in-progress tasks whose agent is stale)
//   - purgeAll() / purgeEverything() variants with different scope
//   - start()/stop() wrapper methods (the agent-common base uses
//     startTimer/stopTimer, but context.ts wires cleanup.start()/stop())
// =============================================================================

import { CleanupService as KitCleanupService } from 'agent-common';
import type { Db } from '../storage/database.js';
import type { AgentBridge } from './agent-bridge.js';
import type { Task } from '../types.js';

const AGENT_COMM_TIMEOUT_MS = parseInt(process.env.AGENT_TASKS_COMM_TIMEOUT_MS ?? '5000', 10);

export interface TasksCleanupStats extends Record<string, number> {
  purgedTasks: number;
  purgedComments: number;
  purgedArtifacts: number;
  purgedApprovals: number;
}

export class CleanupService extends KitCleanupService<TasksCleanupStats> {
  constructor(
    db: Db,
    retentionDays: number = 30,
    private readonly agentBridge?: AgentBridge,
  ) {
    super(db, { retentionDays, autoStart: false });
  }

  start(): void {
    this.startTimer();
    setTimeout(() => {
      this.failStaleAgentTasks().catch(() => {});
    }, 10_000).unref();
  }

  stop(): void {
    this.stopTimer();
  }

  run(): TasksCleanupStats {
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const tasks = this.db.run(
      `DELETE FROM tasks WHERE status IN ('completed', 'cancelled') AND updated_at < ?`,
      [cutoff],
    );

    const comments = this.db.run(
      `DELETE FROM task_comments WHERE task_id NOT IN (SELECT id FROM tasks)`,
    );

    const artifacts = this.db.run(
      `DELETE FROM task_artifacts WHERE task_id NOT IN (SELECT id FROM tasks)`,
    );

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

  override purgeAll(): TasksCleanupStats {
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

  purgeEverything(): TasksCleanupStats {
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
      agents = (await this.fetchAgentsWithTimeout()) as Array<{
        name: string;
        status: string;
        last_heartbeat?: string;
      }>;
    } catch (err) {
      process.stderr.write(
        '[agent-tasks] failStaleAgentTasks fetchAgents error: ' +
          (err instanceof Error ? err.message : String(err)) +
          '\n',
      );
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
      } catch (err) {
        process.stderr.write(
          '[agent-tasks] failStaleAgentTasks task update error: ' +
            (err instanceof Error ? err.message : String(err)) +
            '\n',
        );
      }
    }

    return { failed, checked: agentNames.length };
  }

  private async fetchAgentsWithTimeout(): Promise<unknown[]> {
    if (!this.agentBridge) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AGENT_COMM_TIMEOUT_MS);
    try {
      const result = await Promise.race([
        this.agentBridge.fetchAgents(),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new Error(`agent-comm fetch timed out after ${AGENT_COMM_TIMEOUT_MS}ms`));
          });
        }),
      ]);
      return result;
    } catch (err) {
      process.stderr.write(
        '[agent-tasks] fetchAgentsWithTimeout: ' +
          (err instanceof Error ? err.message : String(err)) +
          '\n',
      );
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}
