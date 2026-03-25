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
  it('purgeAll removes completed and cancelled tasks', () => {
    const t1 = ctx.tasks.create({ title: 'Complete me' }, 'agent-1');
    ctx.tasks.claim(t1.id, 'agent-1');
    ctx.tasks.complete(t1.id, 'done');

    const t2 = ctx.tasks.create({ title: 'Cancel me' }, 'agent-1');
    ctx.tasks.cancel(t2.id, 'not needed');

    const t3 = ctx.tasks.create({ title: 'Keep me' }, 'agent-1');

    const result = ctx.cleanup.purgeAll();
    expect(result.purgedTasks).toBe(2);

    expect(ctx.tasks.getById(t1.id)).toBeNull();
    expect(ctx.tasks.getById(t2.id)).toBeNull();
    expect(ctx.tasks.getById(t3.id)).not.toBeNull();
  });

  it('purgeAll removes resolved approvals', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const approval = ctx.approvals.request(task.id, 'spec');
    ctx.approvals.approve(approval.id, 'reviewer');

    const result = ctx.cleanup.purgeAll();
    expect(result.purgedApprovals).toBe(1);
  });

  it('purgeAll does not remove pending approvals', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.approvals.request(task.id, 'spec');

    const result = ctx.cleanup.purgeAll();
    expect(result.purgedApprovals).toBe(0);
  });

  it('run with retention skips recent tasks', () => {
    const t1 = ctx.tasks.create({ title: 'Complete me' }, 'agent-1');
    ctx.tasks.claim(t1.id, 'agent-1');
    ctx.tasks.complete(t1.id, 'done');

    const result = ctx.cleanup.run();
    expect(result.purgedTasks).toBe(0);
  });

  it('does not purge in-progress tasks', () => {
    const t1 = ctx.tasks.create({ title: 'Working on it' }, 'agent-1');
    ctx.tasks.claim(t1.id, 'agent-1');

    ctx.cleanup.purgeAll();
    expect(ctx.tasks.getById(t1.id)).not.toBeNull();
  });
});

describe('task count', () => {
  it('returns 0 for empty database', () => {
    expect(ctx.tasks.count()).toBe(0);
  });

  it('returns correct count after creating tasks', () => {
    ctx.tasks.create({ title: 'A' }, 'agent-1');
    ctx.tasks.create({ title: 'B' }, 'agent-1');
    ctx.tasks.create({ title: 'C' }, 'agent-1');
    expect(ctx.tasks.count()).toBe(3);
  });

  it('decrements after delete', () => {
    const t = ctx.tasks.create({ title: 'Delete me' }, 'agent-1');
    ctx.tasks.create({ title: 'Keep me' }, 'agent-1');
    ctx.tasks.delete(t.id);
    expect(ctx.tasks.count()).toBe(1);
  });
});
