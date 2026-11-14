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
  it('inherits the parent project and priority unless given its own', () => {
    const parent = ctx.tasks.create({ title: 'Parent', project: 'web', priority: 7 }, 'agent-1');
    const child = ctx.tasks.create({ title: 'Child', parent_id: parent.id }, 'agent-1');
    expect(child.project).toBe('web');
    expect(child.priority).toBe(7);
    const own = ctx.tasks.create(
      { title: 'Own', parent_id: parent.id, project: 'api', priority: 1 },
      'agent-1',
    );
    expect(own.project).toBe('api');
    expect(own.priority).toBe(1);
  });

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

  it('gets subtask progress for several parents at once', () => {
    const p1 = ctx.tasks.create({ title: 'P1' }, 'agent-1');
    const p2 = ctx.tasks.create({ title: 'P2' }, 'agent-1');
    ctx.tasks.create({ title: 'C1', parent_id: p1.id }, 'agent-1');
    ctx.tasks.create({ title: 'C2', parent_id: p1.id }, 'agent-1');
    ctx.tasks.create({ title: 'C3', parent_id: p2.id }, 'agent-1');

    const progress = ctx.tasks.getSubtaskProgressForTasks([p1.id, p2.id]);
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

  it('refuses to delete a parent with an open subtask anywhere below it, naming them', () => {
    const parent = ctx.tasks.create({ title: 'Parent' }, 'agent-1');
    const child = ctx.tasks.create({ title: 'Child', parent_id: parent.id }, 'agent-1');
    const grandchild = ctx.tasks.create({ title: 'Grandchild', parent_id: child.id }, 'agent-2');
    ctx.tasks.claim(grandchild.id, 'agent-2');
    ctx.tasks.complete(grandchild.id, 'done');
    const open = ctx.tasks.create({ title: 'Open', parent_id: child.id }, 'agent-2');
    ctx.tasks.claim(open.id, 'agent-2');
    expect(() => ctx.tasks.delete(parent.id)).toThrow(
      `Task ${parent.id} has open subtasks (#${child.id}, #${open.id}): finish, cancel or delete them first.`,
    );
    expect(ctx.tasks.getById(open.id)).toMatchObject({ status: 'in_progress' });
  });

  it('deletes a parent with its finished subtasks, all levels down', () => {
    const parent = ctx.tasks.create({ title: 'Parent' }, 'agent-1');
    const child = ctx.tasks.create({ title: 'Child', parent_id: parent.id }, 'agent-1');
    const grandchild = ctx.tasks.create({ title: 'Grandchild', parent_id: child.id }, 'agent-1');
    ctx.tasks.cancel(grandchild.id, 'not needed');
    ctx.tasks.cancel(child.id, 'not needed');
    expect(ctx.tasks.descendants(parent.id).map((t) => t.id)).toEqual([child.id, grandchild.id]);
    ctx.tasks.delete(parent.id);
    expect(ctx.tasks.getById(child.id)).toBeNull();
    expect(ctx.tasks.getById(grandchild.id)).toBeNull();
  });

  it('rejects parent_id to nonexistent task', () => {
    expect(() => ctx.tasks.create({ title: 'Orphan', parent_id: 999 }, 'agent-1')).toThrow(
      'not found',
    );
  });
});
