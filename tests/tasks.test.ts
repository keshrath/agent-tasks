import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../src/context.js';
import { createTestContext } from './helpers.js';
import { DEFAULT_STAGES } from '../src/domain/tasks.js';

let ctx: AppContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

describe('pipeline config', () => {
  it('returns default stages', () => {
    expect(ctx.tasks.getPipelineStages()).toEqual(DEFAULT_STAGES);
  });

  it('sets custom stages for a project', () => {
    const config = ctx.tasks.setPipelineConfig('myproject', ['todo', 'doing', 'done']);
    expect(JSON.parse(config.stages)).toEqual(['todo', 'doing', 'done']);
    expect(ctx.tasks.getPipelineStages('myproject')).toEqual(['todo', 'doing', 'done']);
  });

  it('rejects duplicate stages', () => {
    expect(() => ctx.tasks.setPipelineConfig('p', ['a', 'a'])).toThrow('Duplicate stage');
  });

  it('rejects empty stages', () => {
    expect(() => ctx.tasks.setPipelineConfig('p', [])).toThrow('empty');
  });

  it('rejects too many stages', () => {
    const stages = Array.from({ length: 25 }, (_, i) => `stage-${i}`);
    expect(() => ctx.tasks.setPipelineConfig('p', stages)).toThrow('Too many stages');
  });
});

describe('task CRUD', () => {
  it('creates a task in backlog', () => {
    const task = ctx.tasks.create({ title: 'Test task', description: 'Do something' }, 'agent-1');
    expect(task.title).toBe('Test task');
    expect(task.stage).toBe('backlog');
    expect(task.status).toBe('pending');
    expect(task.created_by).toBe('agent-1');
  });

  it('creates a task at a specific stage', () => {
    const task = ctx.tasks.create({ title: 'Mid task', stage: 'implement' }, 'agent-1');
    expect(task.stage).toBe('implement');
    expect(task.status).toBe('in_progress');
  });

  it('lists tasks with filters', () => {
    ctx.tasks.create({ title: 'A', priority: 10, project: 'proj1' }, 'agent-1');
    ctx.tasks.create({ title: 'B', priority: 5, project: 'proj2' }, 'agent-1');
    ctx.tasks.create({ title: 'C', priority: 1, project: 'proj1' }, 'agent-1');

    const all = ctx.tasks.list();
    expect(all).toHaveLength(3);

    const proj1 = ctx.tasks.list({ project: 'proj1' });
    expect(proj1).toHaveLength(2);

    const limited = ctx.tasks.list({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].title).toBe('A');
  });

  it('rejects invalid status filter', () => {
    expect(() => ctx.tasks.list({ status: 'bogus' as 'pending' })).toThrow('Invalid status');
  });

  it('updates task metadata', () => {
    const task = ctx.tasks.create({ title: 'Original' }, 'agent-1');
    const updated = ctx.tasks.update(task.id, { title: 'Updated', priority: 5 });
    expect(updated.title).toBe('Updated');
    expect(updated.priority).toBe(5);
  });

  it('deletes a task with cascade', () => {
    const task = ctx.tasks.create({ title: 'Delete me' }, 'agent-1');
    ctx.tasks.addArtifact(task.id, 'spec', 'content', 'agent-1');
    ctx.tasks.delete(task.id);
    expect(ctx.tasks.getById(task.id)).toBeNull();
    const artifacts = ctx.db.queryAll('SELECT * FROM task_artifacts WHERE task_id = ?', [task.id]);
    expect(artifacts).toHaveLength(0);
  });
});

describe('claiming', () => {
  it('claims a task and advances from backlog', () => {
    const task = ctx.tasks.create({ title: 'Claim me' }, 'agent-1');
    const claimed = ctx.tasks.claim(task.id, 'agent-2');
    expect(claimed.assigned_to).toBe('agent-2');
    expect(claimed.stage).toBe('spec');
    expect(claimed.status).toBe('in_progress');
  });

  it('rejects claiming non-pending task', () => {
    const task = ctx.tasks.create({ title: 'Claim me' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    expect(() => ctx.tasks.claim(task.id, 'agent-2')).toThrow('not pending');
  });
});

describe('advancement', () => {
  it('advances through stages sequentially', () => {
    const task = ctx.tasks.create({ title: 'Flow' }, 'agent-1');
    const claimed = ctx.tasks.claim(task.id, 'agent-1');
    expect(claimed.stage).toBe('spec');

    expect(ctx.tasks.advance(task.id).stage).toBe('plan');
    expect(ctx.tasks.advance(task.id).stage).toBe('implement');
    expect(ctx.tasks.advance(task.id).stage).toBe('test');
    expect(ctx.tasks.advance(task.id).stage).toBe('review');

    const done = ctx.tasks.advance(task.id);
    expect(done.stage).toBe('done');
    expect(done.status).toBe('completed');
  });

  it('advances to a specific stage', () => {
    const task = ctx.tasks.create({ title: 'Skip ahead' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const jumped = ctx.tasks.advance(task.id, 'implement');
    expect(jumped.stage).toBe('implement');
  });

  it('rejects backward advance', () => {
    const task = ctx.tasks.create({ title: 'No back' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.tasks.advance(task.id, 'implement');
    expect(() => ctx.tasks.advance(task.id, 'spec')).toThrow('not ahead');
  });

  it('rejects advance on completed task', () => {
    const task = ctx.tasks.create({ title: 'Done' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.tasks.advance(task.id, 'review');
    ctx.tasks.advance(task.id);
    expect(() => ctx.tasks.advance(task.id)).toThrow('completed');
  });
});

describe('regression', () => {
  it('regresses to an earlier stage', () => {
    const task = ctx.tasks.create({ title: 'Regress me' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.tasks.advance(task.id, 'review');
    const regressed = ctx.tasks.regress(task.id, 'implement', 'Tests failed');
    expect(regressed.stage).toBe('implement');
    expect(regressed.status).toBe('in_progress');
  });

  it('stores rejection artifact', () => {
    const task = ctx.tasks.create({ title: 'Reject me' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.tasks.advance(task.id, 'review');
    ctx.tasks.regress(task.id, 'implement', 'Code quality');
    const artifacts = ctx.tasks.getArtifacts(task.id, 'review');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].name).toBe('rejection');
    expect(artifacts[0].content).toContain('Code quality');
  });
});

describe('completion / failure / cancellation', () => {
  it('completes a task', () => {
    const task = ctx.tasks.create({ title: 'Complete me' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const done = ctx.tasks.complete(task.id, 'All done');
    expect(done.status).toBe('completed');
    expect(done.result).toBe('All done');
  });

  it('fails a task', () => {
    const task = ctx.tasks.create({ title: 'Fail me' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const failed = ctx.tasks.fail(task.id, 'Oops');
    expect(failed.status).toBe('failed');
  });

  it('cancels a task', () => {
    const task = ctx.tasks.create({ title: 'Cancel me' }, 'agent-1');
    const cancelled = ctx.tasks.cancel(task.id, 'No longer needed');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.stage).toBe('cancelled');
  });

  it('rejects cancelling completed task', () => {
    const task = ctx.tasks.create({ title: 'Done' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.tasks.complete(task.id, 'done');
    expect(() => ctx.tasks.cancel(task.id, 'nope')).toThrow('already completed');
  });
});

describe('dependencies', () => {
  it('blocks advancement when dependency is incomplete', () => {
    const dep = ctx.tasks.create({ title: 'Dependency' }, 'agent-1');
    const task = ctx.tasks.create({ title: 'Blocked' }, 'agent-1');
    ctx.tasks.addDependency(task.id, dep.id);

    ctx.tasks.claim(task.id, 'agent-1');
    expect(() => ctx.tasks.advance(task.id)).toThrow('Blocked by incomplete dependencies');
  });

  it('allows advancement when dependency is done', () => {
    const dep = ctx.tasks.create({ title: 'Dependency' }, 'agent-1');
    const task = ctx.tasks.create({ title: 'Not blocked' }, 'agent-1');
    ctx.tasks.addDependency(task.id, dep.id);

    ctx.tasks.claim(dep.id, 'agent-1');
    ctx.tasks.complete(dep.id, 'done');

    ctx.tasks.claim(task.id, 'agent-1');
    const advanced = ctx.tasks.advance(task.id);
    expect(advanced.stage).toBe('plan');
  });

  it('detects cycles', () => {
    const a = ctx.tasks.create({ title: 'A' }, 'agent-1');
    const b = ctx.tasks.create({ title: 'B' }, 'agent-1');
    ctx.tasks.addDependency(a.id, b.id);
    expect(() => ctx.tasks.addDependency(b.id, a.id)).toThrow('cycle');
  });

  it('prevents self-dependency', () => {
    const task = ctx.tasks.create({ title: 'Self' }, 'agent-1');
    expect(() => ctx.tasks.addDependency(task.id, task.id)).toThrow('cannot depend on itself');
  });

  it('removes dependency', () => {
    const a = ctx.tasks.create({ title: 'A' }, 'agent-1');
    const b = ctx.tasks.create({ title: 'B' }, 'agent-1');
    ctx.tasks.addDependency(a.id, b.id);
    ctx.tasks.removeDependency(a.id, b.id);

    ctx.tasks.claim(a.id, 'agent-1');
    const advanced = ctx.tasks.advance(a.id);
    expect(advanced.stage).toBe('plan');
  });

  it('cascades on task delete', () => {
    const a = ctx.tasks.create({ title: 'A' }, 'agent-1');
    const b = ctx.tasks.create({ title: 'B' }, 'agent-1');
    ctx.tasks.addDependency(a.id, b.id);
    ctx.tasks.delete(b.id);
    expect(ctx.tasks.getDependencies(a.id).blockers).toHaveLength(0);
  });

  it('related relationship does not block advancement', () => {
    const related = ctx.tasks.create({ title: 'Related' }, 'agent-1');
    const task = ctx.tasks.create({ title: 'Main' }, 'agent-1');
    ctx.tasks.addDependency(task.id, related.id, 'related');

    ctx.tasks.claim(task.id, 'agent-1');
    const advanced = ctx.tasks.advance(task.id);
    expect(advanced.stage).toBe('plan');
  });

  it('duplicate relationship does not block advancement', () => {
    const dup = ctx.tasks.create({ title: 'Duplicate' }, 'agent-1');
    const task = ctx.tasks.create({ title: 'Original' }, 'agent-1');
    ctx.tasks.addDependency(task.id, dup.id, 'duplicate');

    ctx.tasks.claim(task.id, 'agent-1');
    const advanced = ctx.tasks.advance(task.id);
    expect(advanced.stage).toBe('plan');
  });

  it('defaults to blocks relationship for backward compatibility', () => {
    const dep = ctx.tasks.create({ title: 'Dependency' }, 'agent-1');
    const task = ctx.tasks.create({ title: 'Blocked' }, 'agent-1');
    ctx.tasks.addDependency(task.id, dep.id);

    ctx.tasks.claim(task.id, 'agent-1');
    expect(() => ctx.tasks.advance(task.id)).toThrow('Blocked by incomplete dependencies');

    const deps = ctx.tasks.getAllDependencies();
    const found = deps.find((d) => d.task_id === task.id && d.depends_on === dep.id);
    expect(found?.relationship).toBe('blocks');
  });
});

describe('next task', () => {
  it('returns highest-priority unassigned task', () => {
    ctx.tasks.create({ title: 'Low', priority: 1 }, 'agent-1');
    ctx.tasks.create({ title: 'High', priority: 10 }, 'agent-1');
    ctx.tasks.create({ title: 'Med', priority: 5 }, 'agent-1');

    const next = ctx.tasks.next();
    expect(next?.title).toBe('High');
  });

  it('skips tasks with incomplete dependencies', () => {
    const dep = ctx.tasks.create({ title: 'Dep', priority: 1 }, 'agent-1');
    const blocked = ctx.tasks.create({ title: 'Blocked', priority: 10 }, 'agent-1');
    ctx.tasks.addDependency(blocked.id, dep.id);

    const next = ctx.tasks.next();
    expect(next?.title).toBe('Dep');
  });

  it('filters by project', () => {
    ctx.tasks.create({ title: 'A', priority: 10, project: 'alpha' }, 'agent-1');
    ctx.tasks.create({ title: 'B', priority: 5, project: 'beta' }, 'agent-1');

    const next = ctx.tasks.next('beta');
    expect(next?.title).toBe('B');
  });

  it('returns null when nothing available', () => {
    expect(ctx.tasks.next()).toBeNull();
  });
});

describe('artifacts', () => {
  it('attaches and retrieves artifacts', () => {
    const task = ctx.tasks.create({ title: 'Artifact test' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');

    const artifact = ctx.tasks.addArtifact(task.id, 'spec', 'The specification', 'agent-1');
    expect(artifact.name).toBe('spec');
    expect(artifact.stage).toBe('spec');
    expect(artifact.content).toBe('The specification');

    expect(ctx.tasks.getArtifacts(task.id)).toHaveLength(1);
    expect(ctx.tasks.getArtifacts(task.id, 'spec')).toHaveLength(1);
    expect(ctx.tasks.getArtifacts(task.id, 'plan')).toHaveLength(0);
  });

  it('attaches to explicit stage', () => {
    const task = ctx.tasks.create({ title: 'Artifact test' }, 'agent-1');
    const artifact = ctx.tasks.addArtifact(task.id, 'notes', 'content', 'agent-1', 'plan');
    expect(artifact.stage).toBe('plan');
  });
});

describe('events', () => {
  it('emits task:created on create', () => {
    const events: string[] = [];
    ctx.events.on('task:created', (e) => events.push(e.type));
    ctx.tasks.create({ title: 'Evented' }, 'agent-1');
    expect(events).toEqual(['task:created']);
  });

  it('emits task:claimed on claim', () => {
    const events: string[] = [];
    ctx.events.on('task:claimed', (e) => events.push(e.type));
    const task = ctx.tasks.create({ title: 'Claim me' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    expect(events).toEqual(['task:claimed']);
  });

  it('emits task:advanced on advance', () => {
    const events: string[] = [];
    ctx.events.on('task:advanced', (e) => events.push(e.type));
    const task = ctx.tasks.create({ title: 'Advance me' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.tasks.advance(task.id);
    expect(events).toEqual(['task:advanced']);
  });
});

describe('input validation', () => {
  it('rejects empty title', () => {
    expect(() => ctx.tasks.create({ title: '' }, 'agent-1')).toThrow();
    expect(() => ctx.tasks.create({ title: '   ' }, 'agent-1')).toThrow();
  });

  it('rejects title with null bytes', () => {
    expect(() => ctx.tasks.create({ title: 'bad\x00title' }, 'agent-1')).toThrow('null bytes');
  });

  it('rejects title with control chars', () => {
    expect(() => ctx.tasks.create({ title: 'bad\x01title' }, 'agent-1')).toThrow(
      'control characters',
    );
  });

  it('rejects overly long title', () => {
    expect(() => ctx.tasks.create({ title: 'x'.repeat(501) }, 'agent-1')).toThrow('too long');
  });

  it('rejects artifact with null bytes in content', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    expect(() => ctx.tasks.addArtifact(task.id, 'spec', 'bad\x00content', 'agent-1')).toThrow(
      'null bytes',
    );
  });

  it('rejects too many tags', () => {
    const tags = Array.from({ length: 25 }, (_, i) => `tag-${i}`);
    expect(() => ctx.tasks.create({ title: 'T', tags }, 'agent-1')).toThrow('Too many tags');
  });

  it('trims title whitespace', () => {
    const task = ctx.tasks.create({ title: '  hello  ' }, 'agent-1');
    expect(task.title).toBe('hello');
  });
});

describe('error types', () => {
  it('throws NotFoundError for missing task', () => {
    expect(() => ctx.tasks.advance(999)).toThrow('not found');
  });

  it('throws ConflictError for double claim', () => {
    const task = ctx.tasks.create({ title: 'T' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    expect(() => ctx.tasks.claim(task.id, 'agent-2')).toThrow('not pending');
  });
});
