// =============================================================================
// agent-tasks — Claim holders
//
// A task in progress is kept alive by the session working on it (the one that
// claimed it or last moved it on), not by how recently its agent spoke. Each MCP
// process is a holder for the tasks claimed or advanced through it and beats
// while it runs, idle or not; a host that knows its own session (the Claude
// Code plugin) adopts them and ends its holder when the session ends, so a
// reconnected MCP process loses nothing; a process named again by its agent
// takes back that agent's tasks nothing alive holds (`reclaim`). A holder that
// ended, or went silent, longer than the grace ago is gone, and the tasks in
// progress it still holds fail. A task waiting in a queue stage, or one nothing
// holds, is never failed.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type { Task } from '../types.js';
import { ValidationError } from '../types.js';

/** Minutes a holder may be ended or silent before its open tasks fail. */
export const HOLDER_GRACE_MINUTES = parseFloat(
  process.env.AGENT_TASKS_DEAD_SESSION_GRACE_MINUTES ?? '10',
);

const MAX_HOLDER_LENGTH = 200;
const BEAT_MS = 30_000;

export function validateHolder(holder: unknown): string {
  if (typeof holder !== 'string' || !holder.trim() || holder.length > MAX_HOLDER_LENGTH)
    throw new ValidationError(`holder must be a non-empty string of at most ${MAX_HOLDER_LENGTH}`);
  return holder;
}

export class HolderService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly graceMinutes: number = HOLDER_GRACE_MINUTES,
  ) {}

  /** The holder is alive now: created, revived after an end, or seen again. */
  beat(holder: string): void {
    this.db.run(
      `INSERT INTO holders (id, seen_at, ended_at) VALUES (?, datetime('now'), NULL)
       ON CONFLICT(id) DO UPDATE SET seen_at = datetime('now'), ended_at = NULL`,
      [validateHolder(holder)],
    );
  }

  /** The holder's session ended: its open tasks fail once the grace has passed. */
  end(holder: string): void {
    this.db.run(`UPDATE holders SET ended_at = datetime('now') WHERE id = ? AND ended_at IS NULL`, [
      validateHolder(holder),
    ]);
  }

  /** Moves the tasks in progress in `taskIds` to `holder`, which beats. Returns the ids moved. */
  adopt(holder: string, taskIds: number[]): number[] {
    this.beat(holder);
    return this.db.transaction(() =>
      taskIds.filter(
        (id) =>
          this.db.run(`UPDATE tasks SET holder = ? WHERE id = ? AND status = 'in_progress'`, [
            holder,
            id,
          ]).changes > 0,
      ),
    );
  }

  /** The tasks in progress `holder` holds (one sent back to a queue stage is no one's work). */
  held(holder: string): Task[] {
    return this.db.queryAll<Task>(
      `SELECT * FROM tasks WHERE holder = ? AND status = 'in_progress' ORDER BY id`,
      [validateHolder(holder)],
    );
  }

  /**
   * Holds `holder` for as long as this process runs: it beats and sweeps every
   * `everyMs`; the returned stop ends it. A tick that comes late (the machine slept,
   * so every holder fell silent together) beats without sweeping: the others get one
   * tick to beat again before anything is judged gone. The first tick only beats, for
   * the same reason: a session started right after a wake must not judge the others. When
   * the DB closed before the stop, the holder just falls silent and the grace still applies.
   */
  keep(holder: string, everyMs: number = BEAT_MS): () => void {
    let last = -Infinity;
    const tick = () => {
      const now = Date.now();
      const isLate = now - last > 2 * everyMs;
      last = now;
      try {
        this.beat(holder);
        if (!isLate) this.sweep();
      } catch (err) {
        process.stderr.write(
          `[agent-tasks] holder ${holder}: ${err instanceof Error ? err.message : String(err)}
`,
        );
      }
    };
    tick();
    const timer = setInterval(tick, everyMs);
    timer.unref();
    return () => {
      clearInterval(timer);
      try {
        this.end(holder);
      } catch {
        return;
      }
    };
  }

  /**
   * Moves to `holder` the tasks in progress assigned to `name` that nothing alive holds: an
   * MCP process restarted in the middle of a session (or a host without the plugin) takes back
   * its agent's work when the agent names itself again. Returns the ids moved.
   */
  reclaim(holder: string, name: string): number[] {
    this.beat(holder);
    const grace = `-${this.graceMinutes * 60} seconds`;
    const ids = this.db
      .queryAll<{ id: number }>(
        `SELECT t.id FROM tasks t LEFT JOIN holders h ON h.id = t.holder
          WHERE t.assigned_to = ? AND t.status = 'in_progress'
            AND (t.holder IS NULL OR h.id IS NULL OR h.ended_at IS NOT NULL
                 OR h.seen_at < datetime('now', ?))`,
        [name, grace],
      )
      .map((r) => r.id);
    return this.adopt(holder, ids);
  }

  /** Fails the tasks in progress whose holder is gone; returns them. */
  sweep(): Task[] {
    const grace = `-${this.graceMinutes * 60} seconds`;
    const failed = this.db.transaction(() => {
      const gone = this.db.queryAll<Task & { ended: string | null }>(
        `SELECT t.*, h.ended_at AS ended FROM tasks t LEFT JOIN holders h ON h.id = t.holder
          WHERE t.holder IS NOT NULL AND t.status = 'in_progress'
            AND (h.id IS NULL OR COALESCE(h.ended_at, h.seen_at) < datetime('now', ?))`,
        [grace],
      );
      for (const t of gone) {
        const why = t.ended
          ? `The session holding this task ended without completing it`
          : `The session holding this task stopped answering`;
        this.db.run(
          `UPDATE tasks SET status = 'failed', result = ?, updated_at = datetime('now') WHERE id = ?`,
          [`${why} (${t.assigned_to ?? 'unassigned'}).`, t.id],
        );
      }
      this.db.run(
        `DELETE FROM holders WHERE COALESCE(ended_at, seen_at) < datetime('now', ?)
           AND id NOT IN (SELECT holder FROM tasks WHERE holder IS NOT NULL AND status = 'in_progress')`,
        [grace],
      );
      return gone.map((t) => t.id);
    });
    const tasks = failed
      .map((id) => this.db.queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]))
      .filter((t): t is Task => t !== null);
    for (const task of tasks) this.events.emit('task:failed', { task });
    return tasks;
  }
}
