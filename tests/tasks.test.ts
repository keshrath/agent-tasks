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

  it('counts tasks efficiently', () => {
    expect(ctx.tasks.count()).toBe(0);
    ctx.tasks.create({ title: 'A' }, 'agent-1');
    ctx.tasks.create({ title: 'B' }, 'agent-1');
    expect(ctx.tasks.count()).toBe(2);
    ctx.tasks.create({ title: 'C' }, 'agent-1');
    expect(ctx.tasks.count()).toBe(3);
  });

  it('counts tasks with filters', () => {
    ctx.tasks.create({ title: 'A', project: 'proj1' }, 'agent-1');
    ctx.tasks.create({ title: 'B', project: 'proj2' }, 'agent-1');
    const t3 = ctx.tasks.create({ title: 'C', project: 'proj1' }, 'agent-1');
    ctx.tasks.claim(t3.id, 'agent-1');

    expect(ctx.tasks.count()).toBe(3);
    expect(ctx.tasks.count({ project: 'proj1' })).toBe(2);
    expect(ctx.tasks.count({ status: 'pending' })).toBe(2);
    expect(ctx.tasks.count({ status: 'in_progress' })).toBe(1);
    expect(ctx.tasks.count({ project: 'proj1', status: 'in_progress' })).toBe(1);
    expect(ctx.tasks.count({ stage: 'backlog' })).toBe(2);
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

  it('rejects failing a pending task', () => {
    const task = ctx.tasks.create({ title: 'Pending' }, 'agent-1');
    expect(() => ctx.tasks.fail(task.id, 'oops')).toThrow('not in progress');
  });

  it('rejects failing a nonexistent task', () => {
    expect(() => ctx.tasks.fail(999, 'oops')).toThrow('not found');
  });

  it('rejects completing a pending task', () => {
    const task = ctx.tasks.create({ title: 'Pending' }, 'agent-1');
    expect(() => ctx.tasks.complete(task.id, 'done')).toThrow('not in progress');
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

  it('allows circular related dependencies (no cycle check for non-blocks)', () => {
    const a = ctx.tasks.create({ title: 'A' }, 'agent-1');
    const b = ctx.tasks.create({ title: 'B' }, 'agent-1');
    ctx.tasks.addDependency(a.id, b.id, 'related');
    expect(() => ctx.tasks.addDependency(b.id, a.id, 'related')).not.toThrow();
  });

  it('allows circular duplicate dependencies (no cycle check for non-blocks)', () => {
    const a = ctx.tasks.create({ title: 'A' }, 'agent-1');
    const b = ctx.tasks.create({ title: 'B' }, 'agent-1');
    ctx.tasks.addDependency(a.id, b.id, 'duplicate');
    expect(() => ctx.tasks.addDependency(b.id, a.id, 'duplicate')).not.toThrow();
  });
});

describe('getDependencyClosure (transitive)', () => {
  let ctx: ReturnType<typeof createTestContext>;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => ctx.close());

  it('returns empty closure for an isolated task', () => {
    const t = ctx.tasks.create({ title: 'solo' }, 'agent-1');
    const c = ctx.tasks.getDependencyClosure(t.id);
    expect(c.blockers_transitive).toHaveLength(0);
    expect(c.blocking_transitive).toHaveLength(0);
    expect(c.depth_blockers).toBe(0);
    expect(c.depth_blocking).toBe(0);
  });

  it('walks the full upstream + downstream closure on a 4-level chain', () => {
    const a = ctx.tasks.create({ title: 'A' }, 'agent-1');
    const b = ctx.tasks.create({ title: 'B' }, 'agent-1');
    const c = ctx.tasks.create({ title: 'C' }, 'agent-1');
    const d = ctx.tasks.create({ title: 'D' }, 'agent-1');
    ctx.tasks.addDependency(b.id, a.id);
    ctx.tasks.addDependency(c.id, b.id);
    ctx.tasks.addDependency(d.id, c.id);

    const fromB = ctx.tasks.getDependencyClosure(b.id);
    expect(fromB.blockers_transitive.map((t) => t.id)).toEqual([a.id]);
    expect(fromB.blocking_transitive.map((t) => t.id).sort()).toEqual([c.id, d.id].sort());
    expect(fromB.depth_blockers).toBe(1);
    expect(fromB.depth_blocking).toBe(2);

    const fromD = ctx.tasks.getDependencyClosure(d.id);
    expect(fromD.blockers_transitive.map((t) => t.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(fromD.blocking_transitive).toHaveLength(0);
    expect(fromD.depth_blockers).toBe(3);
  });

  it('handles diamond DAG without double-counting', () => {
    const root = ctx.tasks.create({ title: 'root' }, 'agent-1');
    const left = ctx.tasks.create({ title: 'left' }, 'agent-1');
    const right = ctx.tasks.create({ title: 'right' }, 'agent-1');
    const join = ctx.tasks.create({ title: 'join' }, 'agent-1');
    ctx.tasks.addDependency(left.id, root.id);
    ctx.tasks.addDependency(right.id, root.id);
    ctx.tasks.addDependency(join.id, left.id);
    ctx.tasks.addDependency(join.id, right.id);

    const fromRoot = ctx.tasks.getDependencyClosure(root.id);
    expect(fromRoot.blocking_transitive).toHaveLength(3);
    expect(fromRoot.blocking_transitive.map((t) => t.id).sort()).toEqual(
      [left.id, right.id, join.id].sort(),
    );
    expect(fromRoot.depth_blocking).toBe(2);

    const fromJoin = ctx.tasks.getDependencyClosure(join.id);
    expect(fromJoin.blockers_transitive).toHaveLength(3);
    expect(fromJoin.blockers_transitive.map((t) => t.id).sort()).toEqual(
      [root.id, left.id, right.id].sort(),
    );
  });

  it('only follows blocks edges, not related/duplicate', () => {
    const a = ctx.tasks.create({ title: 'A' }, 'agent-1');
    const b = ctx.tasks.create({ title: 'B' }, 'agent-1');
    const c = ctx.tasks.create({ title: 'C' }, 'agent-1');
    ctx.tasks.addDependency(b.id, a.id, 'blocks');
    ctx.tasks.addDependency(c.id, b.id, 'related');
    const fromA = ctx.tasks.getDependencyClosure(a.id);
    expect(fromA.blocking_transitive.map((t) => t.id)).toEqual([b.id]);
  });

  it('throws NotFoundError for unknown task id', () => {
    expect(() => ctx.tasks.getDependencyClosure(99999)).toThrow();
  });
});

describe('getClaimStatus', () => {
  let ctx: ReturnType<typeof createTestContext>;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => ctx.close());

  it('returns claimable=true for an isolated task', () => {
    const t = ctx.tasks.create({ title: 'solo' }, 'agent-1');
    const s = ctx.tasks.getClaimStatus(t.id);
    expect(s.claimable).toBe(true);
    expect(s.blocked_by).toHaveLength(0);
    expect(s.status).toBe('pending');
  });

  it('returns claimable=false with the specific blocker when a dep is incomplete', () => {
    const dep = ctx.tasks.create({ title: 'must finish first' }, 'agent-1');
    const task = ctx.tasks.create({ title: 'depends on it' }, 'agent-1');
    ctx.tasks.addDependency(task.id, dep.id);
    const s = ctx.tasks.getClaimStatus(task.id);
    expect(s.claimable).toBe(false);
    expect(s.blocked_by).toHaveLength(1);
    expect(s.blocked_by[0].id).toBe(dep.id);
    expect(s.blocked_by[0].title).toBe('must finish first');
  });

  it('returns claimable=true once the blocker is completed', () => {
    const dep = ctx.tasks.create({ title: 'dep' }, 'agent-1');
    const task = ctx.tasks.create({ title: 'task' }, 'agent-1');
    ctx.tasks.addDependency(task.id, dep.id);
    ctx.tasks.claim(dep.id, 'worker-1');
    ctx.tasks.complete(dep.id, 'done');
    const s = ctx.tasks.getClaimStatus(task.id);
    expect(s.claimable).toBe(true);
    expect(s.blocked_by).toHaveLength(0);
  });

  it('lists multiple incomplete blockers', () => {
    const a = ctx.tasks.create({ title: 'A' }, 'agent-1');
    const b = ctx.tasks.create({ title: 'B' }, 'agent-1');
    const c = ctx.tasks.create({ title: 'C' }, 'agent-1');
    ctx.tasks.addDependency(c.id, a.id);
    ctx.tasks.addDependency(c.id, b.id);
    const s = ctx.tasks.getClaimStatus(c.id);
    expect(s.claimable).toBe(false);
    expect(s.blocked_by.map((b) => b.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('treats cancelled and failed dependencies as resolved (not blocking)', () => {
    const dep = ctx.tasks.create({ title: 'dep' }, 'agent-1');
    const task = ctx.tasks.create({ title: 'task' }, 'agent-1');
    ctx.tasks.addDependency(task.id, dep.id);
    ctx.tasks.cancel(dep.id, 'no longer needed');
    const s = ctx.tasks.getClaimStatus(task.id);
    expect(s.claimable).toBe(true);
  });

  it('reports the current status of the task itself', () => {
    const t = ctx.tasks.create({ title: 'in progress' }, 'agent-1');
    ctx.tasks.claim(t.id, 'worker-1');
    const s = ctx.tasks.getClaimStatus(t.id);
    expect(s.status).toBe('in_progress');
  });
});

describe('next task', () => {
  it('returns highest-priority unassigned task', () => {
    ctx.tasks.create({ title: 'Low', priority: 1 }, 'agent-1');
    ctx.tasks.create({ title: 'High', priority: 10 }, 'agent-1');
    ctx.tasks.create({ title: 'Med', priority: 5 }, 'agent-1');

    const next = ctx.tasks.next();
    expect(next?.task.title).toBe('High');
  });

  it('skips tasks with incomplete dependencies', () => {
    const dep = ctx.tasks.create({ title: 'Dep', priority: 1 }, 'agent-1');
    const blocked = ctx.tasks.create({ title: 'Blocked', priority: 10 }, 'agent-1');
    ctx.tasks.addDependency(blocked.id, dep.id);

    const next = ctx.tasks.next();
    expect(next?.task.title).toBe('Dep');
  });

  it('filters by project', () => {
    ctx.tasks.create({ title: 'A', priority: 10, project: 'alpha' }, 'agent-1');
    ctx.tasks.create({ title: 'B', priority: 5, project: 'beta' }, 'agent-1');

    const next = ctx.tasks.next('beta');
    expect(next?.task.title).toBe('B');
  });

  it('returns null when nothing available', () => {
    expect(ctx.tasks.next()).toBeNull();
  });

  it('prefers tasks with agent affinity (parent)', () => {
    const parent = ctx.tasks.create({ title: 'Parent', priority: 1 }, 'agent-1');
    ctx.tasks.claim(parent.id, 'agent-x');
    ctx.tasks.create({ title: 'Child1', priority: 5, parent_id: parent.id }, 'agent-1');
    ctx.tasks.create({ title: 'Child2', priority: 5 }, 'agent-1');

    const next = ctx.tasks.next(undefined, undefined, 'agent-x');
    expect(next?.task.title).toBe('Child1');
    expect(next?.affinity_score).toBeGreaterThan(0);
    expect(next?.affinity_reasons).toContain('worked on parent task');
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

  it('increments version and chains previous_id on same name+stage', () => {
    const task = ctx.tasks.create({ title: 'Versioned' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');

    const v1 = ctx.tasks.addArtifact(task.id, 'spec', 'Version 1', 'agent-1');
    expect(v1.version).toBe(1);
    expect(v1.previous_id).toBeNull();

    const v2 = ctx.tasks.addArtifact(task.id, 'spec', 'Version 2', 'agent-1');
    expect(v2.version).toBe(2);
    expect(v2.previous_id).toBe(v1.id);

    const v3 = ctx.tasks.addArtifact(task.id, 'spec', 'Version 3', 'agent-1');
    expect(v3.version).toBe(3);
    expect(v3.previous_id).toBe(v2.id);

    const all = ctx.tasks.getArtifacts(task.id, 'spec');
    expect(all).toHaveLength(3);
  });

  it('versions independently per name+stage', () => {
    const task = ctx.tasks.create({ title: 'Multi artifact' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');

    const spec1 = ctx.tasks.addArtifact(task.id, 'spec', 'Spec v1', 'agent-1');
    const notes1 = ctx.tasks.addArtifact(task.id, 'notes', 'Notes v1', 'agent-1');
    const spec2 = ctx.tasks.addArtifact(task.id, 'spec', 'Spec v2', 'agent-1');

    expect(spec1.version).toBe(1);
    expect(notes1.version).toBe(1);
    expect(spec2.version).toBe(2);
    expect(spec2.previous_id).toBe(spec1.id);
  });

  it('counts artifacts per task', () => {
    const t1 = ctx.tasks.create({ title: 'T1' }, 'agent-1');
    const t2 = ctx.tasks.create({ title: 'T2' }, 'agent-1');
    ctx.tasks.addArtifact(t1.id, 'a', 'content', 'agent-1');
    ctx.tasks.addArtifact(t1.id, 'b', 'content', 'agent-1');
    ctx.tasks.addArtifact(t2.id, 'c', 'content', 'agent-1');

    const counts = ctx.tasks.getArtifactCounts();
    expect(counts[t1.id]).toBe(2);
    expect(counts[t2.id]).toBe(1);
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

describe('stage gates', () => {
  it('allows advance when no gate config', () => {
    const task = ctx.tasks.create({ title: 'No gate', project: 'ungated' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const advanced = ctx.tasks.advance(task.id);
    expect(advanced.stage).toBe('plan');
  });

  it('blocks advance when require_comment is true and no comment exists', () => {
    ctx.tasks.setPipelineConfig('gated', ['backlog', 'spec', 'plan', 'done']);
    ctx.tasks.setGateConfig('gated', { require_comment: true });
    const task = ctx.tasks.create({ title: 'Gated', project: 'gated' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    expect(() => ctx.tasks.advance(task.id)).toThrow('Stage gate: at least one comment required');
  });

  it('allows advance when require_comment is true and comment exists', () => {
    ctx.tasks.setPipelineConfig('gated2', ['backlog', 'spec', 'plan', 'done']);
    ctx.tasks.setGateConfig('gated2', { require_comment: true });
    const task = ctx.tasks.create({ title: 'Gated2', project: 'gated2' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.comments.add(task.id, 'agent-1', 'Some work done');
    const advanced = ctx.tasks.advance(task.id);
    expect(advanced.stage).toBe('plan');
  });

  it('allows advance when inline comment is passed', () => {
    ctx.tasks.setPipelineConfig('gated3', ['backlog', 'spec', 'plan', 'done']);
    ctx.tasks.setGateConfig('gated3', { require_comment: true });
    const task = ctx.tasks.create({ title: 'Gated3', project: 'gated3' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const advanced = ctx.tasks.advance(task.id, undefined, 'Inline comment');
    expect(advanced.stage).toBe('plan');
  });

  it('exempts specified stages from gate check', () => {
    ctx.tasks.setPipelineConfig('gated4', ['backlog', 'spec', 'plan', 'done']);
    ctx.tasks.setGateConfig('gated4', {
      require_comment: true,
      exempt_stages: ['backlog', 'spec'],
    });
    const task = ctx.tasks.create({ title: 'Gated4', project: 'gated4' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    const advanced = ctx.tasks.advance(task.id);
    expect(advanced.stage).toBe('plan');
  });

  it('blocks advance when require_artifact is true and no artifact at current stage', () => {
    ctx.tasks.setPipelineConfig('art-gate', ['backlog', 'spec', 'plan', 'done']);
    ctx.tasks.setGateConfig('art-gate', { require_artifact: true });
    const task = ctx.tasks.create({ title: 'Art gate', project: 'art-gate' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    expect(() => ctx.tasks.advance(task.id)).toThrow('Stage gate: at least one artifact required');
  });

  it('allows advance when require_artifact is true and artifact exists', () => {
    ctx.tasks.setPipelineConfig('art-gate2', ['backlog', 'spec', 'plan', 'done']);
    ctx.tasks.setGateConfig('art-gate2', { require_artifact: true });
    const task = ctx.tasks.create({ title: 'Art gate2', project: 'art-gate2' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    ctx.tasks.addArtifact(task.id, 'spec-doc', 'The spec', 'agent-1', 'spec');
    const advanced = ctx.tasks.advance(task.id);
    expect(advanced.stage).toBe('plan');
  });

  it('returns null gate config for unconfigured project', () => {
    expect(ctx.tasks.getGateConfig('nonexistent')).toBeNull();
  });

  it('stores and retrieves gate config', () => {
    ctx.tasks.setPipelineConfig('gc-test', ['backlog', 'done']);
    ctx.tasks.setGateConfig('gc-test', { require_comment: true, exempt_stages: ['backlog'] });
    const gate = ctx.tasks.getGateConfig('gc-test');
    expect(gate).toEqual({ require_comment: true, exempt_stages: ['backlog'] });
  });
});

describe('propagateLearnings', () => {
  it('copies learnings to parent and in-progress siblings on completion', () => {
    const parent = ctx.tasks.create({ title: 'Parent task' }, 'agent-1');
    ctx.tasks.claim(parent.id, 'agent-1');

    const child1 = ctx.tasks.create({ title: 'Subtask 1', parent_id: parent.id }, 'agent-1');
    const child2 = ctx.tasks.create({ title: 'Subtask 2', parent_id: parent.id }, 'agent-1');

    ctx.tasks.claim(child1.id, 'agent-1');
    ctx.tasks.claim(child2.id, 'agent-2');

    ctx.tasks.learn(child1.id, 'Use batch inserts for performance', 'technique', 'agent-1');

    ctx.tasks.complete(child1.id, 'Done');

    const parentArtifacts = ctx.tasks.getArtifacts(parent.id).filter((a) => a.name === 'learning');
    expect(parentArtifacts).toHaveLength(1);
    expect(parentArtifacts[0].content).toContain('Learning from subtask');
    expect(parentArtifacts[0].content).toContain('Use batch inserts for performance');

    const siblingArtifacts = ctx.tasks.getArtifacts(child2.id).filter((a) => a.name === 'learning');
    expect(siblingArtifacts).toHaveLength(1);
    expect(siblingArtifacts[0].content).toContain('Learning from sibling');
    expect(siblingArtifacts[0].content).toContain('Use batch inserts for performance');
  });
});

describe('learnings edge cases', () => {
  it('accepts all 4 categories: technique, pitfall, decision, pattern', () => {
    const categories = ['technique', 'pitfall', 'decision', 'pattern'] as const;
    for (const category of categories) {
      const task = ctx.tasks.create({ title: `Learn ${category}` }, 'agent-1');
      ctx.tasks.claim(task.id, 'agent-1');
      const artifact = ctx.tasks.learn(task.id, `Insight about ${category}`, category, 'agent-1');
      expect(artifact.content).toContain(`[${category}]`);
      expect(artifact.name).toBe('learning');
    }
  });

  it('rejects invalid category', () => {
    const task = ctx.tasks.create({ title: 'Bad category' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');
    expect(() => ctx.tasks.learn(task.id, 'Some insight', 'invalid-cat', 'agent-1')).toThrow(
      'Invalid learning category',
    );
  });

  it('only propagates learnings to in-progress siblings, not completed or pending ones', () => {
    const parent = ctx.tasks.create({ title: 'Parent' }, 'agent-1');
    ctx.tasks.claim(parent.id, 'agent-1');

    const completing = ctx.tasks.create(
      { title: 'Completing child', parent_id: parent.id },
      'agent-1',
    );
    const inProgress = ctx.tasks.create(
      { title: 'In-progress child', parent_id: parent.id },
      'agent-1',
    );
    const pending = ctx.tasks.create({ title: 'Pending child', parent_id: parent.id }, 'agent-1');
    const completed = ctx.tasks.create(
      { title: 'Completed child', parent_id: parent.id },
      'agent-1',
    );

    ctx.tasks.claim(completing.id, 'agent-1');
    ctx.tasks.claim(inProgress.id, 'agent-2');
    ctx.tasks.claim(completed.id, 'agent-3');
    ctx.tasks.complete(completed.id, 'Already done');

    ctx.tasks.learn(completing.id, 'Use batch inserts', 'technique', 'agent-1');
    ctx.tasks.complete(completing.id, 'Done');

    const inProgressArtifacts = ctx.tasks
      .getArtifacts(inProgress.id)
      .filter((a) => a.name === 'learning');
    expect(inProgressArtifacts.length).toBeGreaterThan(0);
    expect(inProgressArtifacts[0].content).toContain('Learning from sibling');

    const pendingArtifacts = ctx.tasks
      .getArtifacts(pending.id)
      .filter((a) => a.name === 'learning');
    expect(pendingArtifacts).toHaveLength(0);

    const completedArtifacts = ctx.tasks
      .getArtifacts(completed.id)
      .filter((a) => a.content.includes('Learning from sibling'));
    expect(completedArtifacts).toHaveLength(0);
  });

  it('propagates multiple learnings from same task on completion', () => {
    const parent = ctx.tasks.create({ title: 'Parent' }, 'agent-1');
    ctx.tasks.claim(parent.id, 'agent-1');

    const child1 = ctx.tasks.create({ title: 'Child 1', parent_id: parent.id }, 'agent-1');
    const child2 = ctx.tasks.create({ title: 'Child 2', parent_id: parent.id }, 'agent-1');

    ctx.tasks.claim(child1.id, 'agent-1');
    ctx.tasks.claim(child2.id, 'agent-2');

    ctx.tasks.learn(child1.id, 'First insight', 'technique', 'agent-1');
    ctx.tasks.learn(child1.id, 'Second insight', 'pitfall', 'agent-1');

    ctx.tasks.complete(child1.id, 'Done');

    const parentLearnings = ctx.tasks.getArtifacts(parent.id).filter((a) => a.name === 'learning');
    expect(parentLearnings).toHaveLength(2);
    expect(parentLearnings[0].content).toContain('First insight');
    expect(parentLearnings[1].content).toContain('Second insight');

    const siblingLearnings = ctx.tasks.getArtifacts(child2.id).filter((a) => a.name === 'learning');
    expect(siblingLearnings).toHaveLength(2);
  });
});

describe('agent affinity edge cases', () => {
  it('gives affinity_score=0 to agent with no history', () => {
    ctx.tasks.create({ title: 'Orphan task', priority: 5 }, 'agent-1');

    const next = ctx.tasks.next(undefined, undefined, 'brand-new-agent');
    expect(next).not.toBeNull();
    expect(next!.affinity_score).toBe(0);
    expect(next!.affinity_reasons).toHaveLength(0);
  });

  it('ranks tasks by affinity when priority is equal', () => {
    const parentA = ctx.tasks.create({ title: 'Parent A', priority: 1 }, 'agent-1');
    ctx.tasks.claim(parentA.id, 'agent-x');
    ctx.tasks.complete(parentA.id, 'done');

    const parentB = ctx.tasks.create({ title: 'Parent B', priority: 1 }, 'agent-1');
    ctx.tasks.claim(parentB.id, 'agent-y');
    ctx.tasks.complete(parentB.id, 'done');

    ctx.tasks.create({ title: 'Child A', priority: 10, parent_id: parentA.id }, 'agent-1');
    ctx.tasks.create({ title: 'Child B', priority: 10 }, 'agent-1');
    ctx.tasks.create({ title: 'Child C', priority: 10, parent_id: parentB.id }, 'agent-1');

    const next = ctx.tasks.next(undefined, undefined, 'agent-x');
    expect(next).not.toBeNull();
    expect(next!.task.title).toBe('Child A');
    expect(next!.affinity_score).toBeGreaterThan(0);
  });

  it('gives affinity boost for dependency task history', () => {
    const dep = ctx.tasks.create({ title: 'Dependency', priority: 1 }, 'agent-1');
    ctx.tasks.claim(dep.id, 'agent-x');
    ctx.tasks.complete(dep.id, 'done');

    const taskWithDep = ctx.tasks.create({ title: 'Has dep', priority: 10 }, 'agent-1');
    ctx.tasks.create({ title: 'No dep', priority: 10 }, 'agent-1');
    ctx.tasks.addDependency(taskWithDep.id, dep.id);

    const next = ctx.tasks.next(undefined, undefined, 'agent-x');
    expect(next).not.toBeNull();
    expect(next!.task.title).toBe('Has dep');
    expect(next!.affinity_score).toBeGreaterThan(0);
    expect(next!.affinity_reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('dependency')]),
    );
  });
});

describe('stage gates combinations', () => {
  it('enforces both require_comment AND require_artifacts per-stage gates', () => {
    ctx.tasks.setPipelineConfig('combo-gate', ['backlog', 'spec', 'plan', 'done']);
    ctx.tasks.setGateConfig('combo-gate', {
      gates: {
        spec: { require_comment: true, require_artifacts: ['spec-doc'] },
      },
    });
    const task = ctx.tasks.create({ title: 'Combo gate', project: 'combo-gate' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');

    expect(() => ctx.tasks.advance(task.id)).toThrow('comment required');

    ctx.comments.add(task.id, 'agent-1', 'Here is a comment');
    expect(() => ctx.tasks.advance(task.id)).toThrow('required artifacts missing');

    ctx.tasks.addArtifact(task.id, 'spec-doc', 'The spec document', 'agent-1', 'spec');
    const advanced = ctx.tasks.advance(task.id);
    expect(advanced.stage).toBe('plan');
  });

  it('enforces require_min_artifacts with count > 1', () => {
    ctx.tasks.setPipelineConfig('min-art-gate', ['backlog', 'spec', 'plan', 'done']);
    ctx.tasks.setGateConfig('min-art-gate', {
      gates: {
        spec: { require_min_artifacts: 3 },
      },
    });
    const task = ctx.tasks.create(
      { title: 'Min artifacts gate', project: 'min-art-gate' },
      'agent-1',
    );
    ctx.tasks.claim(task.id, 'agent-1');

    expect(() => ctx.tasks.advance(task.id)).toThrow('at least 3 artifact(s) required');

    ctx.tasks.addArtifact(task.id, 'art-1', 'Content 1', 'agent-1', 'spec');
    ctx.tasks.addArtifact(task.id, 'art-2', 'Content 2', 'agent-1', 'spec');
    expect(() => ctx.tasks.advance(task.id)).toThrow('at least 3 artifact(s) required');

    ctx.tasks.addArtifact(task.id, 'art-3', 'Content 3', 'agent-1', 'spec');
    const advanced = ctx.tasks.advance(task.id);
    expect(advanced.stage).toBe('plan');
  });

  it('enforces require_approval gate and blocks without approval', () => {
    ctx.tasks.setPipelineConfig('approval-gate', ['backlog', 'spec', 'plan', 'done']);
    ctx.tasks.setGateConfig('approval-gate', {
      gates: {
        spec: { require_approval: true },
      },
    });
    const task = ctx.tasks.create({ title: 'Approval gate', project: 'approval-gate' }, 'agent-1');
    ctx.tasks.claim(task.id, 'agent-1');

    expect(() => ctx.tasks.advance(task.id)).toThrow('approval required');

    const approval = ctx.approvals.request(task.id, 'spec', 'reviewer-1');
    expect(() => ctx.tasks.advance(task.id)).toThrow('approval required');

    ctx.approvals.approve(approval.id, 'reviewer-1');
    const advanced = ctx.tasks.advance(task.id);
    expect(advanced.stage).toBe('plan');
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
