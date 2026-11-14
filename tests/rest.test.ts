// =============================================================================
// REST API integration tests
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import { createContext, type AppContext } from '../src/context.js';
import { startRestServer, type RestServer } from '../src/server.js';

let server: RestServer;
let ctx: AppContext;
let baseUrl: string;

beforeAll(async () => {
  ctx = createContext({ path: ':memory:' });
  server = await startRestServer(ctx, 0);
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
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.tasks).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Request guard
// ---------------------------------------------------------------------------

describe('Request guard', () => {
  it('refuses every request that carries an Origin, loopback included', async () => {
    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:3000', 'https://evil.com']) {
      expect((await api('/api/board', { headers: { Origin: origin } })).status).toBe(403);
      const del = await api('/api/tasks/1', { method: 'DELETE', headers: { Origin: origin } });
      expect(del.status).toBe(403);
      const post = await api('/api/tasks', {
        ...jsonBody({ title: 'from a web page' }),
        headers: { 'Content-Type': 'application/json', Origin: origin },
      });
      expect(post.status).toBe(403);
    }
    expect(ctx.tasks.count()).toBe(0);
  });

  it('rejects a text/plain POST body', async () => {
    const res = await api('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ title: 'evil' }),
    });
    expect(res.status).toBe(415);
  });
});

// ---------------------------------------------------------------------------
// Tasks CRUD
// ---------------------------------------------------------------------------

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
    expect(task.id).toBeGreaterThan(0);
    expect(task.title).toBe('Test task');
    expect(task.description).toBe('A task for testing');
    expect(task.priority).toBe(5);
    expect(task.project).toBe('test-project');
    expect(task.status).toBe('pending');
    expect(task.stage).toBe('backlog');
    expect(task.created_by).toBe('api');
    expect(task.created_at).toMatch(/^\d{4}-/);
    expect(task.updated_at).toMatch(/^\d{4}-/);
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
    expect(body.error).toEqual(expect.any(String));
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

  it('includes subtasks, artifacts and comments on request', async () => {
    const res = await api('/api/tasks/1?include=subtasks,comments');
    const task = await res.json();
    expect(task).toMatchObject({ id: 1, subtasks: [], comments: [], artifacts: [] });
    expect(task.dependencies).toEqual({ blockers: [], blocking: [], links: [] });
  });

  it('lists only blocks links as blockers, the others as links', async () => {
    const blocker = ctx.tasks.create({ title: 'Blocker' }, 'test');
    const related = ctx.tasks.create({ title: 'Related' }, 'test');
    const task = ctx.tasks.create({ title: 'Linked' }, 'test');
    ctx.tasks.addDependency(task.id, blocker.id);
    ctx.tasks.addDependency(task.id, related.id, 'related');
    const body = await (await api(`/api/tasks/${task.id}`)).json();
    expect(body.dependencies.blockers.map((t: { id: number }) => t.id)).toEqual([blocker.id]);
    expect(body.dependencies.links).toMatchObject([
      { task: { id: related.id }, relationship: 'related', direction: 'outgoing' },
    ]);
  });

  it('gives the transitive dependency chain with include=transitive_deps', async () => {
    const top = ctx.tasks.create({ title: 'Top' }, 'test');
    const mid = ctx.tasks.create({ title: 'Mid' }, 'test');
    const low = ctx.tasks.create({ title: 'Low' }, 'test');
    ctx.tasks.addDependency(top.id, mid.id);
    ctx.tasks.addDependency(mid.id, low.id);
    const body = await (await api(`/api/tasks/${top.id}?include=transitive_deps`)).json();
    expect(body.transitive_deps.depth_blockers).toBe(2);
    expect(
      body.transitive_deps.blockers_transitive.map((t: { id: number }) => t.id).sort(),
    ).toEqual([mid.id, low.id].sort());
  });

  it('says what the stage gate still needs (gate_needs), what the pane reads', async () => {
    ctx.tasks.setGateConfig('rest-gated', { require_comment: true });
    const task = ctx.tasks.create({ title: 'Gated', project: 'rest-gated' }, 'test');
    const get = async () => (await (await api(`/api/tasks/${task.id}`)).json()).gate_needs;
    expect(await get()).toMatchObject({ stage: 'backlog', comment: true, artifacts: [] });
    ctx.comments.add(task.id, 'agent-1', 'looked at it');
    expect(await get()).toBeNull();
  });

  it('returns 404 for non-existent task', async () => {
    const res = await api('/api/tasks/99999');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Stage transitions
// ---------------------------------------------------------------------------

describe('POST /api/tasks/:id/stage', () => {
  const stage = (id: number, body: Record<string, unknown>) =>
    api(`/api/tasks/${id}/stage`, jsonBody(body));

  it('advance with the stage the pane drew refuses a task moved elsewhere: 409', async () => {
    const t = ctx.tasks.create({ title: 'Moved under the pane' }, 'test');
    ctx.tasks.claim(t.id, 'agent-a');
    const res = await stage(t.id, { action: 'advance', stage: 'plan', from: 'plan', by: 'mathi' });
    expect(res.status).toBe(409);
    expect(ctx.tasks.getById(t.id)!.stage).toBe('spec');
  });

  it('claims for the named claimer and lands in the next stage', async () => {
    const created = await (await api('/api/tasks', jsonBody({ title: 'Lifecycle task' }))).json();
    const res = await stage(created.id, { action: 'claim', by: 'mathi' });
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task).toMatchObject({ assigned_to: 'mathi', status: 'in_progress', stage: 'spec' });
  });

  it('advances, leaving the comment under the actor', async () => {
    const created = await (await api('/api/tasks', jsonBody({ title: 'Advance task' }))).json();
    await stage(created.id, { action: 'claim', by: 'mathi' });
    const res = await stage(created.id, { action: 'advance', comment: 'spec ok', by: 'mathi' });
    expect((await res.json()).stage).toBe('plan');
    const { comments } = await (await api(`/api/tasks/${created.id}?include=comments`)).json();
    expect(comments).toEqual([expect.objectContaining({ agent_id: 'mathi', content: 'spec ok' })]);
  });

  it('regresses with a reason, then completes with a result', async () => {
    const created = await (await api('/api/tasks', jsonBody({ title: 'Regress task' }))).json();
    await stage(created.id, { action: 'claim', by: 'mathi' });
    await stage(created.id, { action: 'advance' });
    const back = await stage(created.id, {
      action: 'regress',
      stage: 'spec',
      reason: 'rework',
      by: 'mathi',
    });
    expect((await back.json()).stage).toBe('spec');
    const { artifacts } = await (await api(`/api/tasks/${created.id}`)).json();
    expect(artifacts).toEqual([
      expect.objectContaining({ name: 'rejection', created_by: 'mathi', stage: 'plan' }),
    ]);
    const done = await stage(created.id, { action: 'complete', result: 'shipped' });
    expect(await done.json()).toMatchObject({ status: 'completed', stage: 'done' });
  });

  it('refuses a missing result, an unknown action and an unknown task', async () => {
    const created = await (await api('/api/tasks', jsonBody({ title: 'Refused task' }))).json();
    await stage(created.id, { action: 'claim' });
    expect((await stage(created.id, { action: 'complete' })).status).toBe(422);
    expect((await stage(created.id, { action: 'teleport' })).status).toBe(422);
    expect((await stage(99999, { action: 'claim' })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

describe('POST /api/tasks/:id/comments', () => {
  it('creates a comment under the named author and returns 201', async () => {
    const res = await api(
      '/api/tasks/1/comments',
      jsonBody({ content: 'Looks good', agent_id: 'r1' }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ task_id: 1, agent_id: 'r1', content: 'Looks good' });
  });

  it('defaults the author to api', async () => {
    const res = await api('/api/tasks/1/comments', jsonBody({ content: 'Comment from API' }));
    expect((await res.json()).agent_id).toBe('api');
  });

  it('refuses an empty comment and an unknown task', async () => {
    expect((await api('/api/tasks/1/comments', jsonBody({ content: ' ' }))).status).toBe(422);
    const res = await api('/api/tasks/99999/comments', jsonBody({ content: 'Should fail' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('DELETE /api/tasks/:id', () => {
  it('deletes a task, then answers 404', async () => {
    const t = ctx.tasks.create({ title: 'Delete me' }, 'test');
    const res = await api(`/api/tasks/${t.id}`, { method: 'DELETE' });
    expect(await res.json()).toEqual({ ok: true });
    expect((await api(`/api/tasks/${t.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses a parent with an open subtask: 409, naming it', async () => {
    const parent = ctx.tasks.create({ title: 'Parent' }, 'test');
    const child = ctx.tasks.create({ title: 'Child', parent_id: parent.id }, 'test');
    const res = await api(`/api/tasks/${parent.id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(`#${child.id}`);
    expect(ctx.tasks.getById(child.id)).not.toBeNull();
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
    expect(Array.isArray(body.stages)).toBe(true);
    expect(body.stages.length).toBeGreaterThan(0);
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
    expect(Array.isArray(body.stages)).toBe(true);
    expect(body.stages.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

describe('GET /api/board', () => {
  it('returns every open task, the recently closed ones and their row facts', async () => {
    const open = await (await api('/api/tasks', jsonBody({ title: 'Open task' }))).json();
    const closed = await (await api('/api/tasks', jsonBody({ title: 'Closed task' }))).json();
    await api(`/api/tasks/${closed.id}/stage`, jsonBody({ action: 'cancel', reason: 'dup' }));
    const res = await api('/api/board');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.open.map((t: { id: number }) => t.id)).toContain(open.id);
    expect(body.open.every((t: { status: string }) => /pending|in_progress/.test(t.status))).toBe(
      true,
    );
    expect(body.recent[0]).toMatchObject({ id: closed.id, status: 'cancelled' });
    expect(Array.isArray(body.dependencies)).toBe(true);
    expect(body.subtaskProgress).toEqual(expect.any(Object));
    expect(body.stages).toEqual([
      'backlog',
      'spec',
      'plan',
      'implement',
      'test',
      'review',
      'done',
      'cancelled',
    ]);
    expect(body.pipelines).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// JSON API headers
// ---------------------------------------------------------------------------

describe('Response headers', () => {
  it('returns JSON content-type on API routes', async () => {
    const res = await api('/api/board');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('never sends a wildcard CORS header on API responses', async () => {
    const res = await api('/api/board');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('includes X-Content-Type-Options header', async () => {
    const res = await api('/api/board');
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
    expect(body.error).toMatch(/json/i);
  });
});
