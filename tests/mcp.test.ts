import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../src/context.js';
import { createTestContext } from './helpers.js';
import { createToolHandler, tools } from '../src/transport/mcp.js';
import type { ToolHandler } from '../src/transport/mcp.js';

let ctx: AppContext;
let handle: ToolHandler;

beforeEach(() => {
  ctx = createTestContext();
  handle = createToolHandler(ctx);
  handle('task_set_session', { id: 'test-id', name: 'test-agent' });
});

afterEach(() => {
  ctx.close();
});

describe('tool definitions', () => {
  it('has unique tool names', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all tools have required inputSchema', () => {
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });
});

describe('session management', () => {
  it('sets session via task_set_session', () => {
    const result = handle('task_set_session', { id: 'abc', name: 'my-agent' }) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
  });

  it('uses session name for created_by', () => {
    handle('task_set_session', { id: 'abc', name: 'my-agent' });
    const task = handle('task_create', { title: 'Test' }) as { created_by: string };
    expect(task.created_by).toBe('my-agent');
  });

  it('defaults to system when no session', () => {
    const freshHandle = createToolHandler(ctx);
    const task = freshHandle('task_create', { title: 'Test' }) as { created_by: string };
    expect(task.created_by).toBe('system');
  });
});

describe('input validation at transport layer', () => {
  it('rejects missing required string', () => {
    expect(() => handle('task_create', {})).toThrow('"title" must be a non-empty string');
  });

  it('rejects missing required number', () => {
    expect(() => handle('task_claim', {})).toThrow('"task_id" is required and must be a number');
  });

  it('rejects non-string for string field', () => {
    expect(() => handle('task_create', { title: 123 })).toThrow('"title" must be a non-empty');
  });

  it('rejects non-array for tags', () => {
    expect(() => handle('task_create', { title: 'T', tags: 'not-array' })).toThrow(
      'array of strings',
    );
  });
});

describe('tool dispatch', () => {
  it('creates and lists tasks', () => {
    handle('task_create', { title: 'A', priority: 5 });
    handle('task_create', { title: 'B', priority: 10 });

    const list = handle('task_list', {}) as { id: number }[];
    expect(list).toHaveLength(2);
  });

  it('round-trips through pipeline', () => {
    const task = handle('task_create', { title: 'Pipeline test' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_advance', { task_id: task.id });
    const result = handle('task_complete', { task_id: task.id, result: 'All done' }) as {
      status: string;
    };
    expect(result.status).toBe('completed');
  });

  it('handles task_next returning no-tasks message', () => {
    const result = handle('task_next', {}) as { message: string };
    expect(result.message).toBe('No available tasks.');
  });

  it('handles pipeline_config get', () => {
    const result = handle('task_pipeline_config', {}) as { stages: string[] };
    expect(result.stages).toContain('backlog');
    expect(result.stages).toContain('done');
  });

  it('handles task_delete', () => {
    const task = handle('task_create', { title: 'Delete me' }) as { id: number };
    const result = handle('task_delete', { task_id: task.id }) as { success: boolean };
    expect(result.success).toBe(true);
  });

  it('rejects unknown tool', () => {
    expect(() => handle('nonexistent_tool', {})).toThrow('Unknown tool');
  });
});
