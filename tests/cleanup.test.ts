import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../src/context.js';
import { createTestContext } from './helpers.js';

let ctx: AppContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

describe('cleanup service', () => {
  it('purges completed tasks older than retention', () => {
    const task = ctx.tasks.create({ title: 'Old task' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.tasks.complete(task.id, 'done');

    ctx.db.run(`UPDATE tasks SET updated_at = datetime('now', '-60 days') WHERE id = ?`, [task.id]);

    const result = ctx.cleanup.run();
    expect(result.purgedTasks).toBe(1);
    expect(ctx.tasks.getById(task.id)).toBeNull();
  });

  it('purges cancelled tasks older than retention', () => {
    const task = ctx.tasks.create({ title: 'Cancelled task' }, 'agent-1');
    ctx.tasks.cancel(task.id, 'no longer needed');

    ctx.db.run(`UPDATE tasks SET updated_at = datetime('now', '-60 days') WHERE id = ?`, [task.id]);

    const result = ctx.cleanup.run();
    expect(result.purgedTasks).toBe(1);
  });

  it('keeps recent completed tasks', () => {
    const task = ctx.tasks.create({ title: 'Recent task' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.tasks.complete(task.id, 'done');

    const result = ctx.cleanup.run();
    expect(result.purgedTasks).toBe(0);
    expect(ctx.tasks.getById(task.id)).not.toBeNull();
  });

  it('keeps in-progress tasks', () => {
    const task = ctx.tasks.create({ title: 'Active task' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');

    ctx.db.run(`UPDATE tasks SET updated_at = datetime('now', '-60 days') WHERE id = ?`, [task.id]);

    const result = ctx.cleanup.run();
    expect(result.purgedTasks).toBe(0);
    expect(ctx.tasks.getById(task.id)).not.toBeNull();
  });

  it('purges resolved approvals older than retention', () => {
    const task = ctx.tasks.create({ title: 'Approval task' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const approval = ctx.approvals.request(task.id, 'spec');
    ctx.approvals.approve(approval.id, 'reviewer');

    ctx.db.run(`UPDATE task_approvals SET resolved_at = datetime('now', '-60 days') WHERE id = ?`, [
      approval.id,
    ]);

    const result = ctx.cleanup.run();
    expect(result.purgedApprovals).toBe(1);
  });

  it('keeps pending approvals', () => {
    const task = ctx.tasks.create({ title: 'Pending approval' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.approvals.request(task.id, 'spec');

    const result = ctx.cleanup.run();
    expect(result.purgedApprovals).toBe(0);
  });

  it('purgeAll removes all completed and cancelled tasks', () => {
    const t1 = ctx.tasks.create({ title: 'Complete' }, 'agent-1');
    ctx.tasks.claim(t1.id, 'agent-1');
    ctx.tasks.complete(t1.id, 'done');

    const t2 = ctx.tasks.create({ title: 'Cancel' }, 'agent-1');
    ctx.tasks.cancel(t2.id, 'nope');

    ctx.tasks.create({ title: 'Active' }, 'agent-1');

    const result = ctx.cleanup.purgeAll();
    expect(result.purgedTasks).toBe(2);
    expect(ctx.tasks.list()).toHaveLength(1);
  });

  it('purgeAll does not remove pending approvals', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.approvals.request(task.id, 'spec');

    const result = ctx.cleanup.purgeAll();
    expect(result.purgedApprovals).toBe(0);
  });
});

describe('stale agent cleanup', () => {
  it('returns empty when no agent bridge', async () => {
    const result = await ctx.cleanup.failStaleAgentTasks();
    expect(result.failed).toHaveLength(0);
    expect(result.checked).toBe(0);
  });

  it('returns empty when no in-progress tasks', async () => {
    const result = await ctx.cleanup.failStaleAgentTasks();
    expect(result.failed).toHaveLength(0);
  });
});
