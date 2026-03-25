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

describe('search', () => {
  it('finds tasks by title', () => {
    ctx.tasks.create({ title: 'Fix authentication bug' }, 'agent-1');
    ctx.tasks.create({ title: 'Add dark mode' }, 'agent-1');
    ctx.tasks.create({ title: 'Refactor authentication middleware' }, 'agent-1');

    const results = ctx.tasks.search('authentication');
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.task.title.includes('authentication'))).toBe(true);
  });

  it('finds tasks by description', () => {
    ctx.tasks.create(
      { title: 'Task A', description: 'This involves database migration' },
      'agent-1',
    );
    ctx.tasks.create({ title: 'Task B', description: 'Frontend only' }, 'agent-1');

    const results = ctx.tasks.search('database');
    expect(results).toHaveLength(1);
    expect(results[0].task.title).toBe('Task A');
  });

  it('filters by project', () => {
    ctx.tasks.create({ title: 'Auth fix', project: 'backend' }, 'agent-1');
    ctx.tasks.create({ title: 'Auth UI', project: 'frontend' }, 'agent-1');

    const results = ctx.tasks.search('auth', { project: 'backend' });
    expect(results).toHaveLength(1);
    expect(results[0].task.project).toBe('backend');
  });

  it('returns empty for no matches', () => {
    ctx.tasks.create({ title: 'Something' }, 'agent-1');
    const results = ctx.tasks.search('nonexistent');
    expect(results).toHaveLength(0);
  });

  it('returns empty for empty query', () => {
    ctx.tasks.create({ title: 'Something' }, 'agent-1');
    const results = ctx.tasks.search('');
    expect(results).toHaveLength(0);
  });

  it('sanitizes FTS operators', () => {
    ctx.tasks.create({ title: 'Test AND query' }, 'agent-1');
    const results = ctx.tasks.search('AND OR NOT');
    expect(results).toHaveLength(0);
  });

  it('limits results', () => {
    for (let i = 0; i < 10; i++) {
      ctx.tasks.create({ title: `Task search item ${i}` }, 'agent-1');
    }
    const results = ctx.tasks.search('search', { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('includes snippets with highlights', () => {
    ctx.tasks.create({ title: 'Important authentication feature' }, 'agent-1');
    const results = ctx.tasks.search('authentication');
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toContain('<mark>');
  });
});
