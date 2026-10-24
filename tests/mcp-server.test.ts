// =============================================================================
// MCP server over the official SDK — the JSON-RPC a client actually sees:
// initialize, tools/list, every tool and action, errors, the pipeline footer
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from '@modelcontextprotocol/server';
import { createMcpServer, PIPELINE_FOOTER } from '../src/transport/mcp.js';
import { readPackageMeta } from '../src/package-meta.js';
import type { AppContext } from '../src/context.js';
import { createTestContext } from './helpers.js';

interface ToolText {
  text: string;
  isError: boolean;
}

let ctx: AppContext;
let client: InMemoryTransport;
let initialized: number;
let nextId = 1;
const waiting = new Map<number, (msg: Record<string, unknown>) => void>();

async function connect(footer = true): Promise<void> {
  const server = createMcpServer(ctx, { footer, onInitialized: () => initialized++ });
  const [c, s] = InMemoryTransport.createLinkedPair();
  client = c;
  client.onmessage = (msg: JSONRPCMessage) => {
    const m = msg as Record<string, unknown>;
    if (typeof m.id === 'number') waiting.get(m.id)?.(m);
  };
  await server.connect(s);
  await client.start();
}

function rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    void client.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  });
}

async function handshake(): Promise<Record<string, unknown>> {
  const res = await rpc('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await new Promise((r) => setTimeout(r, 10));
  return res;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolText> {
  const res = await rpc('tools/call', { name, arguments: args });
  const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
  return { text: result.content[0]!.text, isError: result.isError === true };
}

/** A successful call's JSON (the footer cut off). */
async function ok<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await call(name, args);
  expect(res.isError, res.text).toBe(false);
  expect(res.text.endsWith(PIPELINE_FOOTER)).toBe(true);
  return JSON.parse(res.text.slice(0, -PIPELINE_FOOTER.length)) as T;
}

async function fails(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await call(name, args);
  expect(res.isError).toBe(true);
  return res.text;
}

beforeEach(async () => {
  ctx = createTestContext();
  initialized = 0;
  await connect();
});

afterEach(async () => {
  await client.close();
  ctx.close();
});

describe('handshake', () => {
  it('answers initialize with the package name and version and a tools capability', async () => {
    const res = await handshake();
    const result = res.result as Record<string, unknown>;
    expect(result.serverInfo).toMatchObject(readPackageMeta());
    expect(result.capabilities).toMatchObject({ tools: {} });
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('calls onInitialized once the client says it is initialized', async () => {
    expect(initialized).toBe(0);
    await handshake();
    expect(initialized).toBe(1);
  });

  it('answers ping', async () => {
    await handshake();
    expect((await rpc('ping')).result).toEqual({});
  });
});

describe('tools/list', () => {
  it('lists the 8 tools, each with an object input schema', async () => {
    await handshake();
    const { tools } = (await rpc('tools/list')).result as {
      tools: Array<{ name: string; inputSchema: { type: string } }>;
    };
    expect(tools.map((t) => t.name)).toEqual([
      'task_create',
      'task_get',
      'task_list',
      'task_update',
      'task_delete',
      'task_stage',
      'task_artifact',
      'task_config',
    ]);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
  });
});

describe('every tool and action', () => {
  beforeEach(handshake);

  it('task_config session, then task_create / get / list / update / delete', async () => {
    expect(await ok('task_config', { action: 'session', id: 's1', name: 'agent-x' })).toEqual({
      success: true,
      id: 's1',
      name: 'agent-x',
    });
    const a = await ok<{ id: number; created_by: string }>('task_create', {
      title: 'Alpha',
      project: 'p',
      priority: 3,
      tags: ['x'],
    });
    expect(a.created_by).toBe('agent-x');
    const b = await ok<{ id: number; project: string }>('task_create', {
      title: 'Beta',
      parent_id: a.id,
    });
    expect(b.project).toBe('p');

    const got = await ok<{ subtasks: unknown[] }>('task_get', {
      task_id: a.id,
      include: ['subtasks', 'artifacts', 'comments'],
    });
    expect(got.subtasks).toHaveLength(1);

    expect(await ok<unknown[]>('task_list', { project: 'p' })).toHaveLength(2);
    expect(await ok<unknown[]>('task_list', { tags: ['x'] })).toHaveLength(1);
    expect(JSON.stringify(await ok('task_list', { query: 'Alpha' }))).toContain('Alpha');
    expect(await ok<{ id: number }>('task_list', { next: true })).toMatchObject({ id: a.id });

    await ok('task_update', { task_id: b.id, title: 'Beta 2' });
    expect(ctx.tasks.getById(b.id)?.title).toBe('Beta 2');
    await ok('task_update', {
      task_id: b.id,
      dependency: { action: 'add', depends_on: a.id, relationship: 'blocks' },
    });
    expect(ctx.tasks.getDependenciesForTasks([b.id])).toEqual([
      expect.objectContaining({ task_id: b.id, depends_on: a.id, relationship: 'blocks' }),
    ]);

    await ok('task_delete', { task_id: b.id });
    expect(ctx.tasks.getById(b.id)).toBeNull();
  });

  it('task_stage: claim, assign, advance, regress, complete, fail, cancel', async () => {
    const t = (title: string) => ctx.tasks.create({ title }, 'test').id;
    const a = t('A');
    expect(
      await ok('task_stage', { action: 'claim', task_id: a, claimer: 'agent-a' }),
    ).toMatchObject({ status: 'in_progress', stage: 'spec', assigned_to: 'agent-a' });
    expect(await ok('task_stage', { action: 'advance', task_id: a })).toMatchObject({
      stage: 'plan',
    });
    expect(
      await ok('task_stage', { action: 'regress', task_id: a, stage: 'spec', reason: 'redo' }),
    ).toMatchObject({ stage: 'spec' });
    expect(
      await ok('task_stage', { action: 'complete', task_id: a, result: 'done' }),
    ).toMatchObject({ status: 'completed', stage: 'done' });

    const b = t('B');
    expect(
      await ok('task_stage', { action: 'assign', task_id: b, claimer: 'agent-b' }),
    ).toMatchObject({ assigned_to: 'agent-b', stage: 'backlog', status: 'in_progress' });
    expect(await ok('task_stage', { action: 'fail', task_id: b, result: 'broke' })).toMatchObject({
      status: 'failed',
    });

    const c = t('C');
    expect(await ok('task_stage', { action: 'cancel', task_id: c, reason: 'dup' })).toMatchObject({
      status: 'cancelled',
    });
  });

  it('task_artifact: general, decision, learning, comment (threaded)', async () => {
    const id = ctx.tasks.create({ title: 'Doc' }, 'test').id;
    ctx.tasks.claim(id, 'agent-a');
    await ok('task_artifact', { type: 'general', task_id: id, name: 'spec', content: 'S' });
    await ok('task_artifact', {
      type: 'decision',
      task_id: id,
      chose: 'SQLite',
      over: 'Postgres',
      because: 'local',
    });
    await ok('task_artifact', { type: 'learning', task_id: id, content: 'WAL helps' });
    expect(ctx.tasks.getArtifacts(id).map((a) => a.name)).toEqual(
      expect.arrayContaining(['spec', 'decision', 'learning']),
    );
    const parent = await ok<{ id: number }>('task_artifact', {
      type: 'comment',
      task_id: id,
      content: 'Top',
    });
    await ok('task_artifact', {
      type: 'comment',
      task_id: id,
      content: 'Reply',
      parent_comment_id: parent.id,
    });
    const comments = ctx.comments.list(id);
    expect(comments.map((c) => c.content)).toEqual(['Top', 'Reply']);
    expect(comments[1]!.parent_comment_id).toBe(parent.id);
  });

  it('task_config: pipeline get and set with gates, cleanup, rules', async () => {
    await ok('task_config', {
      action: 'pipeline',
      project: 'g',
      stages: ['todo', 'doing', 'done'],
      gate_config: { require_comment: true },
    });
    expect(await ok('task_config', { action: 'pipeline', project: 'g' })).toMatchObject({
      stages: ['todo', 'doing', 'done'],
    });
    expect(ctx.tasks.getGateConfig('g')?.require_comment).toBe(true);
    expect(await ok('task_config', { action: 'cleanup' })).toBeTypeOf('object');
    expect(
      JSON.stringify(await ok('task_config', { action: 'rules', format: 'claude_md' })),
    ).toContain('task_stage');
  });
});

describe('errors', () => {
  beforeEach(handshake);

  it('names the error code: not found, validation, conflict', async () => {
    expect(await fails('task_get', { task_id: 999 })).toBe(
      'Error [NOT_FOUND]: Task not found: 999',
    );
    expect(await fails('task_create', {})).toMatch(/^Error \[VALIDATION_ERROR\]: /);
    const id = ctx.tasks.create({ title: 'Open' }, 'test').id;
    expect(await fails('task_stage', { action: 'complete', task_id: id, result: 'x' })).toMatch(
      /^Error \[CONFLICT\]: Task \d+ not in progress/,
    );
  });

  it('refuses an unknown tool, and the gate and dependency refusals come through', async () => {
    expect(await fails('task_nope', {})).toBe('Error [VALIDATION_ERROR]: Unknown tool: task_nope');
    ctx.tasks.setPipelineConfig('gated', ['todo', 'doing', 'done']);
    ctx.tasks.setGateConfig('gated', { require_comment: true });
    const gated = ctx.tasks.create({ title: 'Gated', project: 'gated' }, 'test').id;
    ctx.tasks.claim(gated, 'agent-a');
    expect(await fails('task_stage', { action: 'advance', task_id: gated })).toContain(
      'Stage gate',
    );
    const blocker = ctx.tasks.create({ title: 'Blocker' }, 'test').id;
    const blocked = ctx.tasks.create({ title: 'Blocked' }, 'test').id;
    ctx.tasks.addDependency(blocked, blocker);
    ctx.tasks.claim(blocked, 'agent-a');
    expect(await fails('task_stage', { action: 'advance', task_id: blocked })).toContain(
      'Blocked by incomplete dependencies',
    );
  });
});

describe('footer', () => {
  it('is left off when the server is built without it', async () => {
    await client.close();
    await connect(false);
    await handshake();
    const res = await call('task_list', {});
    expect(res.text).toBe('[]');
  });
});
