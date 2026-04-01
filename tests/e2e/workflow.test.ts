// =============================================================================
// E2E tests — full pipeline workflows
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext } from '../helpers.js';
import type { AppContext } from '../../src/context.js';

let ctx: AppContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

describe('Full workflow: create -> claim -> advance -> complete', () => {
  it('moves a task through all default stages to completion', () => {
    const task = ctx.tasks.create({ title: 'Build auth module' }, 'agent-1');
    expect(task.status).toBe('pending');
    expect(task.stage).toBe('backlog');

    const claimed = ctx.tasks.claim(task.id, 'agent-1');
    expect(claimed.status).toBe('in_progress');
    expect(claimed.stage).toBe('spec');
    expect(claimed.assigned_to).toBe('agent-1');

    const specTask = ctx.tasks.advance(task.id, 'plan');
    expect(specTask.stage).toBe('plan');

    const planTask = ctx.tasks.advance(task.id, 'implement');
    expect(planTask.stage).toBe('implement');

    const implTask = ctx.tasks.advance(task.id, 'test');
    expect(implTask.stage).toBe('test');

    const testTask = ctx.tasks.advance(task.id, 'review');
    expect(testTask.stage).toBe('review');

    const completed = ctx.tasks.complete(task.id, 'Auth module implemented');
    expect(completed.status).toBe('completed');
    expect(completed.stage).toBe('done');
    expect(completed.result).toBe('Auth module implemented');
  });

  it('advances one stage at a time when no target is given', () => {
    const task = ctx.tasks.create({ title: 'Incremental advance' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    expect(ctx.tasks.getById(task.id)!.stage).toBe('spec');

    ctx.tasks.advance(task.id);
    expect(ctx.tasks.getById(task.id)!.stage).toBe('plan');

    ctx.tasks.advance(task.id);
    expect(ctx.tasks.getById(task.id)!.stage).toBe('implement');
  });

  it('supports failing a task', () => {
    const task = ctx.tasks.create({ title: 'Will fail' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');

    const failed = ctx.tasks.fail(task.id, 'Build error');
    expect(failed.status).toBe('failed');
    expect(failed.result).toBe('Build error');
  });

  it('supports cancelling a task', () => {
    const task = ctx.tasks.create({ title: 'Will cancel' }, 'agent-1');
    const cancelled = ctx.tasks.cancel(task.id, 'No longer needed');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.stage).toBe('cancelled');
  });

  it('supports regression to earlier stage', () => {
    const task = ctx.tasks.create({ title: 'Needs rework' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.tasks.advance(task.id, 'implement');
    expect(ctx.tasks.getById(task.id)!.stage).toBe('implement');

    const regressed = ctx.tasks.regress(task.id, 'spec', 'Spec was incomplete');
    expect(regressed.stage).toBe('spec');
  });
});

describe('Subtask creation and progress tracking', () => {
  it('creates subtasks under a parent and tracks progress', () => {
    const parent = ctx.tasks.create({ title: 'Parent task' }, 'agent-1');

    const sub1 = ctx.tasks.create({ title: 'Subtask 1', parent_id: parent.id }, 'agent-1');
    const sub2 = ctx.tasks.create({ title: 'Subtask 2', parent_id: parent.id }, 'agent-1');
    const sub3 = ctx.tasks.create({ title: 'Subtask 3', parent_id: parent.id }, 'agent-1');

    expect(sub1.parent_id).toBe(parent.id);

    const subtasks = ctx.tasks.getSubtasks(parent.id);
    expect(subtasks).toHaveLength(3);

    let progress = ctx.tasks.getSubtaskProgress(parent.id);
    expect(progress.total).toBe(3);
    expect(progress.done).toBe(0);

    ctx.tasks.claim(sub1.id, 'agent-1');
    ctx.tasks.complete(sub1.id, 'Done');

    progress = ctx.tasks.getSubtaskProgress(parent.id);
    expect(progress.total).toBe(3);
    expect(progress.done).toBe(1);

    ctx.tasks.claim(sub2.id, 'agent-2');
    ctx.tasks.complete(sub2.id, 'Done');
    ctx.tasks.claim(sub3.id, 'agent-3');
    ctx.tasks.complete(sub3.id, 'Done');

    progress = ctx.tasks.getSubtaskProgress(parent.id);
    expect(progress.done).toBe(3);
  });
});

describe('Dependency blocking', () => {
  it('blocks advancement when a blocking dependency is not met', () => {
    const dep = ctx.tasks.create({ title: 'Dependency task' }, 'agent-1');
    const task = ctx.tasks.create({ title: 'Blocked task' }, 'agent-1');

    ctx.tasks.addDependency(task.id, dep.id, 'blocks');

    ctx.tasks.claim(task.id, 'agent-1');

    expect(() => ctx.tasks.advance(task.id)).toThrow(/blocked/i);
  });

  it('allows advancement once blocking dependency is completed', () => {
    const dep = ctx.tasks.create({ title: 'Dependency task' }, 'agent-1');
    const task = ctx.tasks.create({ title: 'Blocked task' }, 'agent-1');

    ctx.tasks.addDependency(task.id, dep.id, 'blocks');

    ctx.tasks.claim(dep.id, 'agent-1');
    ctx.tasks.complete(dep.id, 'Done');

    ctx.tasks.claim(task.id, 'agent-2');
    const advanced = ctx.tasks.advance(task.id);
    expect(advanced.stage).toBe('plan');
  });

  it('does not block on related dependencies', () => {
    const related = ctx.tasks.create({ title: 'Related task' }, 'agent-1');
    const task = ctx.tasks.create({ title: 'Task with relation' }, 'agent-1');

    ctx.tasks.addDependency(task.id, related.id, 'related');

    ctx.tasks.claim(task.id, 'agent-1');
    const advanced = ctx.tasks.advance(task.id);
    expect(advanced.stage).toBe('plan');
  });

  it('prevents circular dependencies', () => {
    const a = ctx.tasks.create({ title: 'Task A' }, 'agent-1');
    const b = ctx.tasks.create({ title: 'Task B' }, 'agent-1');

    ctx.tasks.addDependency(a.id, b.id, 'blocks');

    expect(() => ctx.tasks.addDependency(b.id, a.id, 'blocks')).toThrow(/cycle/i);
  });
});

describe('Learning propagation on completion', () => {
  it('propagates learnings to parent and siblings on completion', () => {
    const parent = ctx.tasks.create({ title: 'Parent' }, 'agent-1');
    const sub1 = ctx.tasks.create({ title: 'Subtask 1', parent_id: parent.id }, 'agent-1');
    const sub2 = ctx.tasks.create({ title: 'Subtask 2', parent_id: parent.id }, 'agent-1');

    ctx.tasks.claim(sub1.id, 'agent-1');
    ctx.tasks.claim(sub2.id, 'agent-2');

    ctx.tasks.learn(sub1.id, 'Use batch queries for performance', 'technique', 'agent-1');

    ctx.tasks.complete(sub1.id, 'Done');

    const parentArtifacts = ctx.tasks.getArtifacts(parent.id);
    const propagated = parentArtifacts.find(
      (a) => a.name === 'learning' && a.content.includes('batch queries'),
    );
    expect(propagated).toBeDefined();

    const siblingArtifacts = ctx.tasks.getArtifacts(sub2.id);
    const sibPropagated = siblingArtifacts.find(
      (a) => a.name === 'learning' && a.content.includes('batch queries'),
    );
    expect(sibPropagated).toBeDefined();
  });
});
