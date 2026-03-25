import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, closeDb } from '../src/db.js';
import { setSession, clearSession } from '../src/session.js';
import {
  createTask,
  listTasks,
  claimTask,
  completeTask,
  failTask,
  cancelTask,
  advanceTask,
  regressTask,
  nextTask,
  addDependency,
  removeDependency,
  addArtifact,
  getArtifacts,
  getPipelineStages,
  setPipelineConfig,
  DEFAULT_STAGES,
} from '../src/tasks.js';

beforeEach(async () => {
  process.env.AGENT_TASKS_TEST = '1';
  closeDb();
  await initDb();
  setSession('test-id', 'test-agent');
});

describe('pipeline config', () => {
  it('returns default stages', () => {
    expect(getPipelineStages()).toEqual(DEFAULT_STAGES);
  });

  it('sets custom stages for a project', () => {
    const config = setPipelineConfig('myproject', ['todo', 'doing', 'done']);
    expect(JSON.parse(config.stages)).toEqual(['todo', 'doing', 'done']);
    expect(getPipelineStages('myproject')).toEqual(['todo', 'doing', 'done']);
  });

  it('rejects duplicate stages', () => {
    expect(() => setPipelineConfig('p', ['a', 'a'])).toThrow('Duplicate stage');
  });
});

describe('task CRUD', () => {
  it('creates a task in backlog', () => {
    const task = createTask('Test task', 'Do something');
    expect(task.title).toBe('Test task');
    expect(task.stage).toBe('backlog');
    expect(task.status).toBe('pending');
    expect(task.created_by).toBe('test-agent');
  });

  it('creates a task at a specific stage', () => {
    const task = createTask('Mid task', undefined, undefined, 'implement');
    expect(task.stage).toBe('implement');
    expect(task.status).toBe('in_progress');
  });

  it('lists tasks with filters', () => {
    createTask('A', undefined, undefined, undefined, 10, 'proj1');
    createTask('B', undefined, undefined, undefined, 5, 'proj2');
    createTask('C', undefined, undefined, undefined, 1, 'proj1');

    const all = listTasks();
    expect(all).toHaveLength(3);

    const proj1 = listTasks(undefined, undefined, undefined, 'proj1');
    expect(proj1).toHaveLength(2);

    const limited = listTasks(undefined, undefined, undefined, undefined, 1);
    expect(limited).toHaveLength(1);
    expect(limited[0].title).toBe('A'); // highest priority first
  });

  it('rejects invalid status filter', () => {
    expect(() => listTasks('bogus')).toThrow('Invalid status');
  });
});

describe('claiming', () => {
  it('claims a task and advances from backlog', () => {
    const task = createTask('Claim me');
    const claimed = claimTask(task.id);
    expect(claimed.assigned_to).toBe('test-agent');
    expect(claimed.stage).toBe('spec');
    expect(claimed.status).toBe('in_progress');
  });

  it('rejects claiming non-pending task', () => {
    const task = createTask('Claim me');
    claimTask(task.id);
    expect(() => claimTask(task.id)).toThrow('not pending');
  });

  it('claims with explicit name', () => {
    const task = createTask('Claim me');
    const claimed = claimTask(task.id, 'other-agent');
    expect(claimed.assigned_to).toBe('other-agent');
  });
});

describe('advancement', () => {
  it('advances through stages sequentially', () => {
    const task = createTask('Flow');
    const claimed = claimTask(task.id);
    expect(claimed.stage).toBe('spec');

    const t2 = advanceTask(task.id);
    expect(t2.stage).toBe('plan');

    const t3 = advanceTask(task.id);
    expect(t3.stage).toBe('implement');

    const t4 = advanceTask(task.id);
    expect(t4.stage).toBe('test');

    const t5 = advanceTask(task.id);
    expect(t5.stage).toBe('review');

    const t6 = advanceTask(task.id);
    expect(t6.stage).toBe('done');
    expect(t6.status).toBe('completed');
  });

  it('advances to a specific stage', () => {
    const task = createTask('Skip ahead');
    claimTask(task.id);
    const jumped = advanceTask(task.id, 'implement');
    expect(jumped.stage).toBe('implement');
  });

  it('rejects backward advance', () => {
    const task = createTask('No back');
    claimTask(task.id);
    advanceTask(task.id, 'implement');
    expect(() => advanceTask(task.id, 'spec')).toThrow('not ahead');
  });

  it('rejects advance on completed task', () => {
    const task = createTask('Done');
    claimTask(task.id);
    advanceTask(task.id, 'review');
    advanceTask(task.id); // -> done
    expect(() => advanceTask(task.id)).toThrow('completed');
  });
});

describe('regression', () => {
  it('regresses to an earlier stage', () => {
    const task = createTask('Regress me');
    claimTask(task.id);
    advanceTask(task.id, 'review');
    const regressed = regressTask(task.id, 'implement', 'Tests failed');
    expect(regressed.stage).toBe('implement');
    expect(regressed.status).toBe('in_progress');
  });

  it('stores rejection artifact', () => {
    const task = createTask('Reject me');
    claimTask(task.id);
    advanceTask(task.id, 'review');
    regressTask(task.id, 'implement', 'Code quality');
    const artifacts = getArtifacts(task.id, 'review');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].name).toBe('rejection');
    expect(artifacts[0].content).toContain('Code quality');
  });
});

describe('completion / failure / cancellation', () => {
  it('completes a task', () => {
    const task = createTask('Complete me');
    claimTask(task.id);
    const done = completeTask(task.id, 'All done');
    expect(done.status).toBe('completed');
    expect(done.result).toBe('All done');
  });

  it('fails a task', () => {
    const task = createTask('Fail me');
    claimTask(task.id);
    const failed = failTask(task.id, 'Oops');
    expect(failed.status).toBe('failed');
  });

  it('cancels a task', () => {
    const task = createTask('Cancel me');
    const cancelled = cancelTask(task.id, 'No longer needed');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.stage).toBe('cancelled');
  });

  it('rejects cancelling completed task', () => {
    const task = createTask('Done');
    claimTask(task.id);
    completeTask(task.id, 'done');
    expect(() => cancelTask(task.id, 'nope')).toThrow('already completed');
  });
});

describe('dependencies', () => {
  it('blocks advancement when dependency is incomplete', () => {
    const dep = createTask('Dependency');
    const task = createTask('Blocked');
    addDependency(task.id, dep.id);

    claimTask(task.id);
    expect(() => advanceTask(task.id)).toThrow('Blocked by incomplete dependencies');
  });

  it('allows advancement when dependency is done', () => {
    const dep = createTask('Dependency');
    const task = createTask('Not blocked');
    addDependency(task.id, dep.id);

    claimTask(dep.id);
    completeTask(dep.id, 'done');

    claimTask(task.id);
    const advanced = advanceTask(task.id);
    expect(advanced.stage).toBe('plan');
  });

  it('detects cycles', () => {
    const a = createTask('A');
    const b = createTask('B');
    addDependency(a.id, b.id);
    expect(() => addDependency(b.id, a.id)).toThrow('cycle');
  });

  it('prevents self-dependency', () => {
    const task = createTask('Self');
    expect(() => addDependency(task.id, task.id)).toThrow('cannot depend on itself');
  });

  it('removes dependency', () => {
    const a = createTask('A');
    const b = createTask('B');
    addDependency(a.id, b.id);
    removeDependency(a.id, b.id);

    claimTask(a.id);
    const advanced = advanceTask(a.id);
    expect(advanced.stage).toBe('plan');
  });
});

describe('next task', () => {
  it('returns highest-priority unassigned task', () => {
    createTask('Low', undefined, undefined, undefined, 1);
    createTask('High', undefined, undefined, undefined, 10);
    createTask('Med', undefined, undefined, undefined, 5);

    const next = nextTask();
    expect(next?.title).toBe('High');
  });

  it('skips tasks with incomplete dependencies', () => {
    const dep = createTask('Dep', undefined, undefined, undefined, 1);
    const blocked = createTask('Blocked', undefined, undefined, undefined, 10);
    addDependency(blocked.id, dep.id);

    const next = nextTask();
    expect(next?.title).toBe('Dep');
  });

  it('filters by project', () => {
    createTask('A', undefined, undefined, undefined, 10, 'alpha');
    createTask('B', undefined, undefined, undefined, 5, 'beta');

    const next = nextTask('beta');
    expect(next?.title).toBe('B');
  });

  it('returns null when nothing available', () => {
    expect(nextTask()).toBeNull();
  });
});

describe('artifacts', () => {
  it('attaches and retrieves artifacts', () => {
    const task = createTask('Artifact test');
    claimTask(task.id);

    const artifact = addArtifact(task.id, '_current_', 'spec', 'The specification');
    expect(artifact.name).toBe('spec');
    expect(artifact.stage).toBe('spec');
    expect(artifact.content).toBe('The specification');

    const all = getArtifacts(task.id);
    expect(all).toHaveLength(1);

    const byStage = getArtifacts(task.id, 'spec');
    expect(byStage).toHaveLength(1);

    const empty = getArtifacts(task.id, 'plan');
    expect(empty).toHaveLength(0);
  });
});

describe('session', () => {
  it('creates tasks without session as system', () => {
    clearSession();
    const task = createTask('No session');
    expect(task.created_by).toBe('system');
  });
});
