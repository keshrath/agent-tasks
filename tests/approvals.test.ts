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

describe('approvals', () => {
  it('requests an approval', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const approval = ctx.approvals.request(task.id, 'spec', 'agent-reviewer');
    expect(approval.task_id).toBe(task.id);
    expect(approval.stage).toBe('spec');
    expect(approval.status).toBe('pending');
    expect(approval.reviewer).toBe('agent-reviewer');
  });

  it('approves a request', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const approval = ctx.approvals.request(task.id, 'spec');
    const resolved = ctx.approvals.approve(approval.id, 'agent-reviewer', 'Looks good');
    expect(resolved.status).toBe('approved');
    expect(resolved.reviewer).toBe('agent-reviewer');
    expect(resolved.comment).toBe('Looks good');
  });

  it('rejects a request', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const approval = ctx.approvals.request(task.id, 'spec');
    const resolved = ctx.approvals.reject(approval.id, 'agent-reviewer', 'Needs more detail');
    expect(resolved.status).toBe('rejected');
    expect(resolved.comment).toBe('Needs more detail');
  });

  it('rejects rejection without comment', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const approval = ctx.approvals.request(task.id, 'spec');
    expect(() => ctx.approvals.reject(approval.id, 'agent-reviewer', '')).toThrow(
      'requires a comment',
    );
  });

  it('prevents double approval request', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.approvals.request(task.id, 'spec');
    expect(() => ctx.approvals.request(task.id, 'spec')).toThrow('already exists');
  });

  it('prevents resolving already resolved', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const approval = ctx.approvals.request(task.id, 'spec');
    ctx.approvals.approve(approval.id, 'r1');
    expect(() => ctx.approvals.approve(approval.id, 'r2')).toThrow('already approved');
  });

  it('lists pending approvals', () => {
    const t1 = ctx.tasks.create({ title: 'T1' }, 'agent-1');
    const t2 = ctx.tasks.create({ title: 'T2' }, 'agent-1');
    ctx.tasks.claim(t1.id, 'agent-1');
    ctx.tasks.claim(t2.id, 'agent-1');
    ctx.approvals.request(t1.id, 'spec', 'agent-reviewer');
    ctx.approvals.request(t2.id, 'spec');

    const pending = ctx.approvals.getPending();
    expect(pending).toHaveLength(2);

    const forReviewer = ctx.approvals.getPending('agent-reviewer');
    expect(forReviewer).toHaveLength(2);
  });

  it('gets approvals for a task', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.approvals.request(task.id, 'spec');

    const approvals = ctx.approvals.getForTask(task.id);
    expect(approvals).toHaveLength(1);
  });

  it('emits events', () => {
    const events: string[] = [];
    ctx.events.on('approval:requested', (e) => events.push(e.type));
    ctx.events.on('approval:approved', (e) => events.push(e.type));
    ctx.events.on('approval:rejected', (e) => events.push(e.type));

    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const a1 = ctx.approvals.request(task.id, 'spec');
    ctx.approvals.approve(a1.id, 'reviewer');

    const a2 = ctx.approvals.request(task.id, 'plan');
    ctx.approvals.reject(a2.id, 'reviewer', 'Needs work');

    expect(events).toEqual([
      'approval:requested',
      'approval:approved',
      'approval:requested',
      'approval:rejected',
    ]);
  });

  it('cascades on task delete', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.approvals.request(task.id, 'spec');
    ctx.tasks.delete(task.id);
    const rows = ctx.db.queryAll('SELECT * FROM task_approvals WHERE task_id = ?', [task.id]);
    expect(rows).toHaveLength(0);
  });
});
