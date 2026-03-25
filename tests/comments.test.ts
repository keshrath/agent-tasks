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

describe('comments', () => {
  it('adds a comment to a task', () => {
    const task = ctx.tasks.create({ title: 'Discuss me' }, 'agent-1');
    const comment = ctx.comments.add(task.id, 'agent-1', 'This needs clarification');
    expect(comment.task_id).toBe(task.id);
    expect(comment.agent_id).toBe('agent-1');
    expect(comment.content).toBe('This needs clarification');
    expect(comment.parent_comment_id).toBeNull();
  });

  it('lists comments in chronological order', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.comments.add(task.id, 'agent-1', 'First');
    ctx.comments.add(task.id, 'agent-2', 'Second');
    ctx.comments.add(task.id, 'agent-1', 'Third');

    const comments = ctx.comments.list(task.id);
    expect(comments).toHaveLength(3);
    expect(comments[0].content).toBe('First');
    expect(comments[2].content).toBe('Third');
  });

  it('supports threaded replies', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    const root = ctx.comments.add(task.id, 'agent-1', 'Root comment');
    const reply = ctx.comments.add(task.id, 'agent-2', 'Reply', root.id);
    expect(reply.parent_comment_id).toBe(root.id);

    const thread = ctx.comments.thread(root.id);
    expect(thread).toHaveLength(2);
  });

  it('rejects comment on nonexistent task', () => {
    expect(() => ctx.comments.add(999, 'agent-1', 'hello')).toThrow('not found');
  });

  it('rejects empty comment', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    expect(() => ctx.comments.add(task.id, 'agent-1', '')).toThrow('empty');
  });

  it('rejects comment with null bytes', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    expect(() => ctx.comments.add(task.id, 'agent-1', 'bad\x00content')).toThrow('null bytes');
  });

  it('rejects reply to nonexistent parent', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    expect(() => ctx.comments.add(task.id, 'agent-1', 'reply', 999)).toThrow('not found');
  });

  it('counts comments per task', () => {
    const t1 = ctx.tasks.create({ title: 'T1' }, 'agent-1');
    const t2 = ctx.tasks.create({ title: 'T2' }, 'agent-1');
    ctx.comments.add(t1.id, 'agent-1', 'A');
    ctx.comments.add(t1.id, 'agent-2', 'B');
    ctx.comments.add(t2.id, 'agent-1', 'C');

    const counts = ctx.comments.countByTask();
    expect(counts[t1.id]).toBe(2);
    expect(counts[t2.id]).toBe(1);
  });

  it('cascades on task delete', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.comments.add(task.id, 'agent-1', 'comment');
    ctx.tasks.delete(task.id);
    const rows = ctx.db.queryAll('SELECT * FROM task_comments WHERE task_id = ?', [task.id]);
    expect(rows).toHaveLength(0);
  });

  it('emits comment:created event', () => {
    const events: string[] = [];
    ctx.events.on('comment:created', (e) => events.push(e.type));
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.comments.add(task.id, 'agent-1', 'hello');
    expect(events).toEqual(['comment:created']);
  });
});
