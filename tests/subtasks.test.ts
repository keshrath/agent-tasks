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

describe('subtasks', () => {
  it('creates a subtask with parent_id', () => {
    const parent = ctx.tasks.create({ title: 'Parent' }, 'agent-1');
    const child = ctx.tasks.create({ title: 'Child', parent_id: parent.id }, 'agent-1');
    expect(child.parent_id).toBe(parent.id);
  });

  it('lists subtasks of a parent', () => {
    const parent = ctx.tasks.create({ title: 'Parent' }, 'agent-1');
    ctx.tasks.create({ title: 'Child 1', parent_id: parent.id }, 'agent-1');
    ctx.tasks.create({ title: 'Child 2', parent_id: parent.id }, 'agent-1');
    ctx.tasks.create({ title: 'Other' }, 'agent-1');

    const subtasks = ctx.tasks.getSubtasks(parent.id);
    expect(subtasks).toHaveLength(2);
  });

  it('calculates subtask progress', () => {
    const parent = ctx.tasks.create({ title: 'Parent' }, 'agent-1');
    const c1 = ctx.tasks.create({ title: 'C1', parent_id: parent.id }, 'agent-1');
    ctx.tasks.create({ title: 'C2', parent_id: parent.id }, 'agent-1');
    const c3 = ctx.tasks.create({ title: 'C3', parent_id: parent.id }, 'agent-1');

    ctx.tasks.claim(c1.id, 'agent-1');
    ctx.tasks.complete(c1.id, 'done');
    ctx.tasks.claim(c3.id, 'agent-1');
    ctx.tasks.complete(c3.id, 'done');

    const progress = ctx.tasks.getSubtaskProgress(parent.id);
    expect(progress.total).toBe(3);
    expect(progress.done).toBe(2);
  });

  it('gets all subtask progress at once', () => {
    const p1 = ctx.tasks.create({ title: 'P1' }, 'agent-1');
    const p2 = ctx.tasks.create({ title: 'P2' }, 'agent-1');
    ctx.tasks.create({ title: 'C1', parent_id: p1.id }, 'agent-1');
    ctx.tasks.create({ title: 'C2', parent_id: p1.id }, 'agent-1');
    ctx.tasks.create({ title: 'C3', parent_id: p2.id }, 'agent-1');

    const progress = ctx.tasks.getAllSubtaskProgress();
    expect(progress[p1.id].total).toBe(2);
    expect(progress[p2.id].total).toBe(1);
  });

  it('filters root_only tasks', () => {
    const parent = ctx.tasks.create({ title: 'Parent' }, 'agent-1');
    ctx.tasks.create({ title: 'Child', parent_id: parent.id }, 'agent-1');

    const rootOnly = ctx.tasks.list({ root_only: true });
    expect(rootOnly).toHaveLength(1);
    expect(rootOnly[0].title).toBe('Parent');
  });

  it('filters by parent_id', () => {
    const parent = ctx.tasks.create({ title: 'Parent' }, 'agent-1');
    ctx.tasks.create({ title: 'Child', parent_id: parent.id }, 'agent-1');
    ctx.tasks.create({ title: 'Other' }, 'agent-1');

    const children = ctx.tasks.list({ parent_id: parent.id });
    expect(children).toHaveLength(1);
    expect(children[0].title).toBe('Child');
  });

  it('cascades delete to subtasks', () => {
    const parent = ctx.tasks.create({ title: 'Parent' }, 'agent-1');
    const child = ctx.tasks.create({ title: 'Child', parent_id: parent.id }, 'agent-1');
    ctx.tasks.delete(parent.id);
    expect(ctx.tasks.getById(child.id)).toBeNull();
  });

  it('rejects parent_id to nonexistent task', () => {
    expect(() => ctx.tasks.create({ title: 'Orphan', parent_id: 999 }, 'agent-1')).toThrow(
      'not found',
    );
  });
});
