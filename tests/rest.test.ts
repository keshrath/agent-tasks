// =============================================================================
// REST API integration tests
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import { createContext, type AppContext } from '../src/context.js';
import { startDashboard, type DashboardServer } from '../src/server.js';

let server: DashboardServer;
let ctx: AppContext;
let baseUrl: string;

beforeAll(async () => {
  ctx = createContext({ path: ':memory:' });
  server = await startDashboard(ctx, 0);
  const addr = server.httpServer.address() as AddressInfo;
  baseUrl = `http://localhost:${addr.port}`;
});

afterAll(() => {
  server?.close();
  ctx?.close();
});

function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

function jsonBody(data: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns ok status and version', async () => {
    const res = await api('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBeDefined();
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.tasks).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

describe('OPTIONS (CORS)', () => {
  it('returns 204 with CORS headers', async () => {
    const res = await api('/api/tasks', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  it('returns CORS headers on any path', async () => {
    const res = await api('/any/path', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// ---------------------------------------------------------------------------
// Tasks CRUD
// ---------------------------------------------------------------------------

describe('GET /api/tasks', () => {
  it('returns empty array initially', async () => {
    const res = await api('/api/tasks');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });
});

describe('POST /api/tasks', () => {
  it('creates a task and returns 201', async () => {
    const res = await api(
      '/api/tasks',
      jsonBody({
        title: 'Test task',
        description: 'A task for testing',
        priority: 5,
        project: 'test-project',
      }),
    );
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.id).toBeDefined();
    expect(task.title).toBe('Test task');
    expect(task.description).toBe('A task for testing');
    expect(task.priority).toBe(5);
    expect(task.project).toBe('test-project');
    expect(task.status).toBe('pending');
    expect(task.stage).toBe('backlog');
    expect(task.created_by).toBe('api');
    expect(task.created_at).toBeDefined();
    expect(task.updated_at).toBeDefined();
  });

  it('creates a task with custom created_by', async () => {
    const res = await api(
      '/api/tasks',
      jsonBody({
        title: 'Agent task',
        created_by: 'my-agent',
      }),
    );
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.created_by).toBe('my-agent');
  });

  it('creates a task with tags', async () => {
    const res = await api(
      '/api/tasks',
      jsonBody({
        title: 'Tagged task',
        tags: ['bug', 'urgent'],
      }),
    );
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.tags).toContain('bug');
    expect(task.tags).toContain('urgent');
  });

  it('rejects missing title', async () => {
    const res = await api(
      '/api/tasks',
      jsonBody({
        description: 'No title here',
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('rejects empty title', async () => {
    const res = await api(
      '/api/tasks',
      jsonBody({
        title: '   ',
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.error).toMatch(/title/i);
  });

  it('rejects title that is too long', async () => {
    const res = await api(
      '/api/tasks',
      jsonBody({
        title: 'x'.repeat(501),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.error).toMatch(/too long/i);
  });

  it('rejects non-string title', async () => {
    const res = await api(
      '/api/tasks',
      jsonBody({
        title: 12345,
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.error).toMatch(/string/i);
  });

  it('rejects non-number priority', async () => {
    const res = await api(
      '/api/tasks',
      jsonBody({
        title: 'Valid title',
        priority: 'high',
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.error).toMatch(/number/i);
  });
});

describe('GET /api/tasks (with data)', () => {
  it('returns tasks that were created', async () => {
    const res = await api('/api/tasks');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(3);
  });

  it('filters by project', async () => {
    const res = await api('/api/tasks?project=test-project');
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.every((t: { project: string }) => t.project === 'test-project')).toBe(true);
  });

  it('filters by status', async () => {
    const res = await api('/api/tasks?status=pending');
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.every((t: { status: string }) => t.status === 'pending')).toBe(true);
  });

  it('respects limit parameter', async () => {
    const res = await api('/api/tasks?limit=1');
    const body = await res.json();
    expect(body.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Single task
// ---------------------------------------------------------------------------

describe('GET /api/tasks/:id', () => {
  it('returns a task by ID', async () => {
    const res = await api('/api/tasks/1');
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.id).toBe(1);
    expect(task.title).toBe('Test task');
  });

  it('returns 404 for non-existent task', async () => {
    const res = await api('/api/tasks/99999');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Task update
// ---------------------------------------------------------------------------

describe('PUT /api/tasks/:id', () => {
  it('updates task title', async () => {
    const res = await api('/api/tasks/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated title' }),
    });
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.title).toBe('Updated title');
  });

  it('updates task priority', async () => {
    const res = await api('/api/tasks/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 99 }),
    });
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.priority).toBe(99);
  });

  it('returns 404 for non-existent task', async () => {
    const res = await api('/api/tasks/99999', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Nope' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns error when no fields provided', async () => {
    const res = await api('/api/tasks/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// Stage transitions
// ---------------------------------------------------------------------------

describe('PUT /api/tasks/:id/stage', () => {
  it('advances a task to the next stage', async () => {
    const res = await api('/api/tasks/1/stage', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'spec' }),
    });
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.stage).toBe('spec');
  });

  it('advances multiple stages forward', async () => {
    const res = await api('/api/tasks/1/stage', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'implement' }),
    });
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.stage).toBe('implement');
  });

  it('regresses a task to an earlier stage', async () => {
    const res = await api('/api/tasks/1/stage', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'spec', reason: 'Needs rework' }),
    });
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.stage).toBe('spec');
  });

  it('returns same task when setting current stage', async () => {
    const res = await api('/api/tasks/1/stage', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'spec' }),
    });
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.stage).toBe('spec');
  });

  it('returns error for invalid stage name', async () => {
    const res = await api('/api/tasks/1/stage', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'nonexistent-stage' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('returns 404 for non-existent task', async () => {
    const res = await api('/api/tasks/99999/stage', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'spec' }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------

describe('GET /api/tasks/:id/subtasks', () => {
  it('returns empty array when no subtasks exist', async () => {
    const res = await api('/api/tasks/1/subtasks');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it('returns subtasks for a parent task', async () => {
    await api(
      '/api/tasks',
      jsonBody({
        title: 'Subtask 1',
        parent_id: 1,
      }),
    );
    await api(
      '/api/tasks',
      jsonBody({
        title: 'Subtask 2',
        parent_id: 1,
      }),
    );

    const res = await api('/api/tasks/1/subtasks');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBe(2);
    expect(body[0].parent_id).toBe(1);
    expect(body[1].parent_id).toBe(1);
  });

  it('returns 404 for non-existent parent', async () => {
    const res = await api('/api/tasks/99999/subtasks');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

describe('GET /api/tasks/:id/artifacts', () => {
  it('returns empty array when no artifacts exist', async () => {
    const t = ctx.tasks.create({ title: 'Artifact test empty' }, 'test');
    const res = await api(`/api/tasks/${t.id}/artifacts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it('returns artifacts after they are created', async () => {
    const t = ctx.tasks.create({ title: 'Artifact test' }, 'test');
    ctx.tasks.claim(t.id, 'test');
    ctx.tasks.addArtifact(t.id, 'design-doc', 'The design document content', 'test-agent', 'spec');
    ctx.tasks.addArtifact(t.id, 'api-spec', 'OpenAPI spec content', 'test-agent', 'spec');

    const res = await api(`/api/tasks/${t.id}/artifacts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBe(2);
    expect(body[0].name).toBe('design-doc');
    expect(body[1].name).toBe('api-spec');
  });

  it('filters artifacts by stage', async () => {
    const t = ctx.tasks.create({ title: 'Artifact filter test' }, 'test');
    ctx.tasks.claim(t.id, 'test');
    ctx.tasks.addArtifact(t.id, 'spec-doc', 'Spec content', 'test-agent', 'spec');
    ctx.tasks.addArtifact(t.id, 'impl-doc', 'Impl content', 'test-agent', 'implement');

    const res = await api(`/api/tasks/${t.id}/artifacts?stage=spec`);
    const body = await res.json();
    expect(body.length).toBe(1);
    expect(body[0].stage).toBe('spec');
  });

  it('returns 404 for non-existent task', async () => {
    const res = await api('/api/tasks/99999/artifacts');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

describe('GET /api/tasks/:id/comments', () => {
  it('returns empty array when no comments exist', async () => {
    const res = await api('/api/tasks/1/comments');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });
});

describe('POST /api/tasks/:id/comments', () => {
  it('creates a comment and returns 201', async () => {
    const res = await api(
      '/api/tasks/1/comments',
      jsonBody({
        content: 'This is a test comment',
        agent_id: 'reviewer-1',
      }),
    );
    expect(res.status).toBe(201);
    const comment = await res.json();
    expect(comment.id).toBeDefined();
    expect(comment.content).toBe('This is a test comment');
    expect(comment.agent_id).toBe('reviewer-1');
    expect(comment.task_id).toBe(1);
  });

  it('creates a comment with default agent_id', async () => {
    const res = await api(
      '/api/tasks/1/comments',
      jsonBody({
        content: 'Comment from API',
      }),
    );
    expect(res.status).toBe(201);
    const comment = await res.json();
    expect(comment.agent_id).toBe('api');
  });

  it('lists comments after creation', async () => {
    const res = await api('/api/tasks/1/comments');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBe(2);
  });

  it('returns error for non-existent task', async () => {
    const res = await api(
      '/api/tasks/99999/comments',
      jsonBody({
        content: 'Should fail',
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

describe('GET /api/dependencies', () => {
  it('returns dependencies after they are created', async () => {
    const t1 = ctx.tasks.create({ title: 'Dep parent' }, 'test');
    const t2 = ctx.tasks.create({ title: 'Dep child' }, 'test');
    ctx.tasks.addDependency(t2.id, t1.id);

    const res = await api('/api/dependencies');
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(
      body.some(
        (d: { task_id: number; depends_on: number }) =>
          d.task_id === t2.id && d.depends_on === t1.id,
      ),
    ).toBe(true);
  });
});

describe('GET /api/tasks/:id/dependencies', () => {
  it('returns dependencies for a specific task', async () => {
    const t1 = ctx.tasks.create({ title: 'Dep query A' }, 'test');
    const t2 = ctx.tasks.create({ title: 'Dep query B' }, 'test');
    ctx.tasks.addDependency(t2.id, t1.id);

    const res = await api(`/api/tasks/${t2.id}/dependencies`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blockers.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 404 for non-existent task', async () => {
    const res = await api('/api/tasks/99999/dependencies');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

describe('GET /api/pipeline', () => {
  it('returns default pipeline stages', async () => {
    const res = await api('/api/pipeline');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stages).toBeDefined();
    expect(Array.isArray(body.stages)).toBe(true);
    expect(body.stages).toContain('backlog');
    expect(body.stages).toContain('spec');
    expect(body.stages).toContain('plan');
    expect(body.stages).toContain('implement');
    expect(body.stages).toContain('test');
    expect(body.stages).toContain('review');
    expect(body.stages).toContain('done');
  });

  it('accepts project filter parameter', async () => {
    const res = await api('/api/pipeline?project=test-project');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stages).toBeDefined();
    expect(Array.isArray(body.stages)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

describe('GET /api/overview', () => {
  it('returns full pipeline state', async () => {
    const res = await api('/api/overview');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks.length).toBeGreaterThanOrEqual(1);

    expect(Array.isArray(body.dependencies)).toBe(true);

    expect(body.artifactCounts).toBeDefined();
    expect(typeof body.artifactCounts).toBe('object');

    expect(body.commentCounts).toBeDefined();
    expect(typeof body.commentCounts).toBe('object');

    expect(body.subtaskProgress).toBeDefined();
    expect(typeof body.subtaskProgress).toBe('object');

    expect(Array.isArray(body.stages)).toBe(true);
    expect(body.stages.length).toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('GET /api/search', () => {
  it('returns empty results for unmatched query', async () => {
    const res = await api('/api/search?q=zzzznonexistent');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it('finds tasks by title', async () => {
    ctx.tasks.create({ title: 'Searchable unique keyword xyzzy' }, 'test');
    const res = await api('/api/search?q=xyzzy');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].task.title).toContain('xyzzy');
  });

  it('respects limit parameter', async () => {
    const res = await api('/api/search?q=task&limit=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeLessThanOrEqual(1);
  });

  it('filters by project', async () => {
    ctx.tasks.create({ title: 'Searchable projfilt', project: 'search-proj' }, 'test');
    const res = await api('/api/search?q=projfilt&project=search-proj');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBe(1);
    expect(body[0].task.project).toBe('search-proj');
  });
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

describe('GET /api/agents', () => {
  it('returns an array (may be empty)', async () => {
    const res = await api('/api/agents');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JSON API headers
// ---------------------------------------------------------------------------

describe('Response headers', () => {
  it('returns JSON content-type on API routes', async () => {
    const res = await api('/api/tasks');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('includes CORS header on API responses', async () => {
    const res = await api('/api/tasks');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('includes X-Content-Type-Options header', async () => {
    const res = await api('/api/tasks');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('Error handling', () => {
  it('returns 404 JSON for unknown API routes', async () => {
    const res = await api('/api/nonexistent', { method: 'POST' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it('handles invalid JSON body gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json }',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});
