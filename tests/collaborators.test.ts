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

describe('collaborators', () => {
  it('adds a collaborator', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    const collab = ctx.collaborators.add(task.id, 'agent-2');
    expect(collab.task_id).toBe(task.id);
    expect(collab.agent_id).toBe('agent-2');
    expect(collab.role).toBe('collaborator');
  });

  it('adds with specific role', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    const collab = ctx.collaborators.add(task.id, 'agent-3', 'reviewer');
    expect(collab.role).toBe('reviewer');
  });

  it('lists collaborators', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.collaborators.add(task.id, 'agent-2');
    ctx.collaborators.add(task.id, 'agent-3', 'reviewer');

    const list = ctx.collaborators.list(task.id);
    expect(list).toHaveLength(2);
  });

  it('removes a collaborator', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.collaborators.add(task.id, 'agent-2');
    ctx.collaborators.remove(task.id, 'agent-2');
    expect(ctx.collaborators.list(task.id)).toHaveLength(0);
  });

  it('rejects duplicate collaborator', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.collaborators.add(task.id, 'agent-2');
    expect(() => ctx.collaborators.add(task.id, 'agent-2')).toThrow('already');
  });

  it('rejects invalid role', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    expect(() => ctx.collaborators.add(task.id, 'agent-2', 'admin' as 'collaborator')).toThrow(
      'Invalid role',
    );
  });

  it('rejects collaborator on nonexistent task', () => {
    expect(() => ctx.collaborators.add(999, 'agent-1')).toThrow('not found');
  });

  it('gets tasks for agent', () => {
    const t1 = ctx.tasks.create({ title: 'T1' }, 'agent-1');
    const t2 = ctx.tasks.create({ title: 'T2' }, 'agent-1');
    ctx.collaborators.add(t1.id, 'agent-2');
    ctx.collaborators.add(t2.id, 'agent-2');

    const tasks = ctx.collaborators.getTasksForAgent('agent-2');
    expect(tasks).toHaveLength(2);
  });

  it('filters tasks by collaborator', () => {
    const t1 = ctx.tasks.create({ title: 'T1' }, 'agent-1');
    ctx.tasks.create({ title: 'T2' }, 'agent-1');
    ctx.collaborators.add(t1.id, 'agent-2');

    const filtered = ctx.tasks.list({ collaborator: 'agent-2' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('T1');
  });

  it('cascades on task delete', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.collaborators.add(task.id, 'agent-2');
    ctx.tasks.delete(task.id);
    const rows = ctx.db.queryAll('SELECT * FROM task_collaborators WHERE task_id = ?', [task.id]);
    expect(rows).toHaveLength(0);
  });

  it('emits events', () => {
    const events: string[] = [];
    ctx.events.on('collaborator:added', (e) => events.push(e.type));
    ctx.events.on('collaborator:removed', (e) => events.push(e.type));
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.collaborators.add(task.id, 'agent-2');
    ctx.collaborators.remove(task.id, 'agent-2');
    expect(events).toEqual(['collaborator:added', 'collaborator:removed']);
  });
});
