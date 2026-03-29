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
  handle('task_config', { action: 'session', id: 'test-id', name: 'test-agent' });
});

afterEach(() => {
  ctx.close();
});

// =============================================================================
// Tool definitions
// =============================================================================

describe('tool definitions', () => {
  it('exports all defined tools', () => {
    expect(tools.length).toBe(13);
  });

  it('has unique tool names', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all tools have required inputSchema', () => {
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(Object.keys(tool.inputSchema.properties).length).toBeGreaterThan(0);
    }
  });

  it('all tool names start with task_', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^task_/);
    }
  });
});

// =============================================================================
// Session management
// =============================================================================

describe('session management', () => {
  it('sets session via task_set_session', () => {
    const result = handle('task_config', { action: 'session', id: 'abc', name: 'my-agent' }) as {
      success: boolean;
      id: string;
      name: string;
    };
    expect(result.success).toBe(true);
    expect(result.id).toBe('abc');
    expect(result.name).toBe('my-agent');
  });

  it('uses session name for created_by', () => {
    handle('task_config', { action: 'session', id: 'abc', name: 'my-agent' });
    const task = handle('task_create', { title: 'Test' }) as { created_by: string };
    expect(task.created_by).toBe('my-agent');
  });

  it('defaults to system when no session', () => {
    const freshHandle = createToolHandler(ctx);
    const task = freshHandle('task_create', { title: 'Test' }) as { created_by: string };
    expect(task.created_by).toBe('system');
  });

  it('rejects set_session without id', () => {
    expect(() => handle('task_config', { action: 'session', name: 'x' })).toThrow(
      '"id" must be a non-empty',
    );
  });

  it('rejects set_session without name', () => {
    expect(() => handle('task_config', { action: 'session', id: 'x' })).toThrow(
      '"name" must be a non-empty',
    );
  });
});

// =============================================================================
// Input validation at transport layer
// =============================================================================

describe('input validation at transport layer', () => {
  it('rejects missing required string (title)', () => {
    expect(() => handle('task_create', {})).toThrow('"title" must be a non-empty string');
  });

  it('rejects missing required number (task_id)', () => {
    expect(() => handle('task_claim', {})).toThrow('"task_id" is required and must be a number');
  });

  it('rejects non-string for string field', () => {
    expect(() => handle('task_create', { title: 123 })).toThrow('"title" must be a non-empty');
  });

  it('rejects non-number for number field', () => {
    expect(() => handle('task_claim', { task_id: 'abc' })).toThrow(
      '"task_id" is required and must be a number',
    );
  });

  it('rejects non-array for tags', () => {
    expect(() => handle('task_create', { title: 'T', tags: 'not-array' })).toThrow(
      'array of strings',
    );
  });

  it('rejects tags with non-string elements', () => {
    expect(() => handle('task_create', { title: 'T', tags: [1, 2] })).toThrow('array of strings');
  });

  it('rejects empty string for required string', () => {
    expect(() => handle('task_create', { title: '  ' })).toThrow('"title" must be a non-empty');
  });

  it('rejects unknown tool', () => {
    expect(() => handle('nonexistent_tool', {})).toThrow('Unknown tool');
  });

  it('rejects non-string for optional string field', () => {
    expect(() => handle('task_create', { title: 'T', description: 42 })).toThrow(
      '"description" must be a string',
    );
  });

  it('rejects non-number for optional number field', () => {
    expect(() => handle('task_create', { title: 'T', priority: 'high' })).toThrow(
      '"priority" must be a number',
    );
  });
});

// =============================================================================
// task_create
// =============================================================================

describe('task_create', () => {
  it('creates a task with only title', () => {
    const task = handle('task_create', { title: 'Minimal' }) as {
      id: number;
      title: string;
      stage: string;
    };
    expect(task.id).toBeGreaterThan(0);
    expect(task.title).toBe('Minimal');
    expect(task.stage).toBe('backlog');
  });

  it('creates a task with all options', () => {
    const task = handle('task_create', {
      title: 'Full task',
      description: 'Detailed desc',
      stage: 'spec',
      priority: 10,
      project: 'my-project',
      tags: ['urgent', 'frontend'],
      assign_to: 'agent-1',
    }) as {
      title: string;
      description: string;
      stage: string;
      priority: number;
      project: string;
      assigned_to: string;
    };
    expect(task.title).toBe('Full task');
    expect(task.description).toBe('Detailed desc');
    expect(task.stage).toBe('spec');
    expect(task.priority).toBe(10);
    expect(task.project).toBe('my-project');
    expect(task.assigned_to).toBe('agent-1');
  });

  it('creates a subtask with parent_id', () => {
    const parent = handle('task_create', { title: 'Parent' }) as { id: number };
    const child = handle('task_create', { title: 'Child', parent_id: parent.id }) as {
      id: number;
      parent_id: number;
    };
    expect(child.parent_id).toBe(parent.id);
  });
});

// =============================================================================
// task_list
// =============================================================================

describe('task_list', () => {
  it('returns empty array initially', () => {
    const list = handle('task_list', {}) as unknown[];
    expect(list).toEqual([]);
  });

  it('lists created tasks', () => {
    handle('task_create', { title: 'A', priority: 5 });
    handle('task_create', { title: 'B', priority: 10 });
    const list = handle('task_list', {}) as { id: number }[];
    expect(list).toHaveLength(2);
  });

  it('filters by project', () => {
    handle('task_create', { title: 'A', project: 'alpha' });
    handle('task_create', { title: 'B', project: 'beta' });
    const list = handle('task_list', { project: 'alpha' }) as { title: string }[];
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('A');
  });

  it('filters by stage', () => {
    handle('task_create', { title: 'Backlog task' });
    handle('task_create', { title: 'Spec task', stage: 'spec' });
    const list = handle('task_list', { stage: 'spec' }) as { title: string }[];
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Spec task');
  });

  it('supports limit and offset', () => {
    for (let i = 0; i < 5; i++) handle('task_create', { title: `Task ${i}` });
    const page = handle('task_list', { limit: 2, offset: 1 }) as unknown[];
    expect(page).toHaveLength(2);
  });
});

// =============================================================================
// task_claim
// =============================================================================

describe('task_claim', () => {
  it('claims a task and sets assignee', () => {
    const task = handle('task_create', { title: 'Claim me' }) as { id: number };
    const claimed = handle('task_claim', { task_id: task.id }) as {
      assigned_to: string;
      status: string;
    };
    expect(claimed.assigned_to).toBe('test-agent');
    expect(claimed.status).toBe('in_progress');
  });

  it('uses custom claimer name', () => {
    const task = handle('task_create', { title: 'Claim me' }) as { id: number };
    const claimed = handle('task_claim', { task_id: task.id, claimer: 'other-agent' }) as {
      assigned_to: string;
    };
    expect(claimed.assigned_to).toBe('other-agent');
  });

  it('rejects claim on nonexistent task', () => {
    expect(() => handle('task_claim', { task_id: 9999 })).toThrow();
  });

  it('rejects missing task_id', () => {
    expect(() => handle('task_claim', {})).toThrow('"task_id" is required');
  });
});

// =============================================================================
// task_advance
// =============================================================================

describe('task_advance', () => {
  it('advances task to next stage', () => {
    const task = handle('task_create', { title: 'Advance me' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const advanced = handle('task_stage', { action: 'advance', task_id: task.id }) as {
      stage: string;
    };
    expect(advanced.stage).toBe('plan');
  });

  it('advances to a specific stage', () => {
    const task = handle('task_create', { title: 'Skip' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const advanced = handle('task_stage', {
      action: 'advance',
      task_id: task.id,
      stage: 'implement',
    }) as {
      stage: string;
    };
    expect(advanced.stage).toBe('implement');
  });

  it('rejects missing task_id', () => {
    expect(() => handle('task_stage', { action: 'advance' })).toThrow('"task_id" is required');
  });

  it('advances with inline comment', () => {
    const task = handle('task_create', { title: 'Comment advance' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const advanced = handle('task_stage', {
      action: 'advance',
      task_id: task.id,
      comment: 'Spec work completed',
    }) as { stage: string };
    expect(advanced.stage).toBe('plan');
    const comments = handle('task_query', { type: 'comments', task_id: task.id }) as Array<{
      content: string;
    }>;
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe('Spec work completed');
  });

  it('enforces stage gate require_comment via pipeline_config', () => {
    handle('task_config', {
      action: 'pipeline',
      project: 'gated-mcp',
      stages: ['backlog', 'spec', 'plan', 'done'],
      gate_config: { require_comment: true, exempt_stages: ['backlog'] },
    });
    const task = handle('task_create', { title: 'Gated MCP', project: 'gated-mcp' }) as {
      id: number;
    };
    handle('task_claim', { task_id: task.id });
    expect(() => handle('task_stage', { action: 'advance', task_id: task.id })).toThrow(
      'Stage gate',
    );
    const advanced = handle('task_stage', {
      action: 'advance',
      task_id: task.id,
      comment: 'Satisfies gate',
    }) as { stage: string };
    expect(advanced.stage).toBe('plan');
  });
});

// =============================================================================
// task_regress
// =============================================================================

describe('task_regress', () => {
  it('regresses task to earlier stage', () => {
    const task = handle('task_create', { title: 'Regress me' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_stage', { action: 'advance', task_id: task.id, stage: 'implement' });
    const regressed = handle('task_stage', {
      action: 'regress',
      task_id: task.id,
      stage: 'spec',
    }) as {
      stage: string;
    };
    expect(regressed.stage).toBe('spec');
  });

  it('accepts optional reason', () => {
    const task = handle('task_create', { title: 'Regress' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_stage', { action: 'advance', task_id: task.id, stage: 'implement' });
    const regressed = handle('task_stage', {
      action: 'regress',
      task_id: task.id,
      stage: 'spec',
      reason: 'Needs rework',
    }) as { stage: string };
    expect(regressed.stage).toBe('spec');
  });

  it('rejects missing stage', () => {
    const task = handle('task_create', { title: 'R' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    expect(() => handle('task_stage', { action: 'regress', task_id: task.id })).toThrow(
      '"stage" must be a non-empty',
    );
  });
});

// =============================================================================
// task_complete / task_fail / task_cancel
// =============================================================================

describe('task_complete', () => {
  it('marks task completed with result', () => {
    const task = handle('task_create', { title: 'Complete me' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const result = handle('task_stage', {
      action: 'complete',
      task_id: task.id,
      result: 'Done',
    }) as {
      status: string;
      result: string;
    };
    expect(result.status).toBe('completed');
    expect(result.result).toBe('Done');
  });

  it('rejects missing result', () => {
    const task = handle('task_create', { title: 'T' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    expect(() => handle('task_stage', { action: 'complete', task_id: task.id })).toThrow(
      '"result" must be a non-empty',
    );
  });
});

describe('task_fail', () => {
  it('marks task as failed', () => {
    const task = handle('task_create', { title: 'Fail me' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const result = handle('task_stage', {
      action: 'fail',
      task_id: task.id,
      result: 'Error occurred',
    }) as {
      status: string;
    };
    expect(result.status).toBe('failed');
  });

  it('rejects missing result', () => {
    const task = handle('task_create', { title: 'T' }) as { id: number };
    expect(() => handle('task_stage', { action: 'fail', task_id: task.id })).toThrow(
      '"result" must be a non-empty',
    );
  });
});

describe('task_cancel', () => {
  it('cancels a task with reason', () => {
    const task = handle('task_create', { title: 'Cancel me' }) as { id: number };
    const result = handle('task_stage', {
      action: 'cancel',
      task_id: task.id,
      reason: 'No longer needed',
    }) as {
      status: string;
    };
    expect(result.status).toBe('cancelled');
  });

  it('rejects missing reason', () => {
    const task = handle('task_create', { title: 'T' }) as { id: number };
    expect(() => handle('task_stage', { action: 'cancel', task_id: task.id })).toThrow(
      '"reason" must be a non-empty',
    );
  });
});

// =============================================================================
// task_update
// =============================================================================

describe('task_update', () => {
  it('updates task title', () => {
    const task = handle('task_create', { title: 'Original' }) as { id: number };
    const updated = handle('task_update', { task_id: task.id, title: 'Updated' }) as {
      title: string;
    };
    expect(updated.title).toBe('Updated');
  });

  it('updates priority and project', () => {
    const task = handle('task_create', { title: 'T' }) as { id: number };
    const updated = handle('task_update', {
      task_id: task.id,
      priority: 99,
      project: 'new-project',
    }) as { priority: number; project: string };
    expect(updated.priority).toBe(99);
    expect(updated.project).toBe('new-project');
  });

  it('rejects missing task_id', () => {
    expect(() => handle('task_update', { title: 'X' })).toThrow('"task_id" is required');
  });
});

// =============================================================================
// task_next
// =============================================================================

describe('task_list next mode', () => {
  it('returns no-tasks message when empty', () => {
    const result = handle('task_list', { next: true }) as { message: string };
    expect(result.message).toBe('No available tasks.');
  });

  it('returns highest priority unassigned task', () => {
    handle('task_create', { title: 'Low', priority: 1 });
    handle('task_create', { title: 'High', priority: 100 });
    const result = handle('task_list', { next: true }) as { title: string; priority: number };
    expect(result.title).toBe('High');
    expect(result.priority).toBe(100);
  });

  it('filters by project', () => {
    handle('task_create', { title: 'Alpha task', project: 'alpha', priority: 1 });
    handle('task_create', { title: 'Beta task', project: 'beta', priority: 100 });
    const result = handle('task_list', { next: true, project: 'alpha' }) as { title: string };
    expect(result.title).toBe('Alpha task');
  });
});

// =============================================================================
// task_delete
// =============================================================================

describe('task_delete', () => {
  it('deletes a task', () => {
    const task = handle('task_create', { title: 'Delete me' }) as { id: number };
    const result = handle('task_delete', { task_id: task.id }) as { success: boolean };
    expect(result.success).toBe(true);
    const list = handle('task_list', {}) as unknown[];
    expect(list).toHaveLength(0);
  });

  it('rejects missing task_id', () => {
    expect(() => handle('task_delete', {})).toThrow('"task_id" is required');
  });
});

// =============================================================================
// task_dependency
// =============================================================================

describe('task_dependency', () => {
  it('adds a dependency between tasks', () => {
    const a = handle('task_create', { title: 'A' }) as { id: number };
    const b = handle('task_create', { title: 'B' }) as { id: number };
    const result = handle('task_dependency', {
      action: 'add',
      task_id: b.id,
      depends_on: a.id,
    }) as {
      success: boolean;
      task_id: number;
      depends_on: number;
    };
    expect(result.success).toBe(true);
    expect(result.task_id).toBe(b.id);
    expect(result.depends_on).toBe(a.id);
  });

  it('rejects missing depends_on', () => {
    const a = handle('task_create', { title: 'A' }) as { id: number };
    expect(() => handle('task_dependency', { action: 'add', task_id: a.id })).toThrow(
      '"depends_on" is required',
    );
  });

  it('removes a dependency', () => {
    const a = handle('task_create', { title: 'A' }) as { id: number };
    const b = handle('task_create', { title: 'B' }) as { id: number };
    handle('task_dependency', { action: 'add', task_id: b.id, depends_on: a.id });
    const result = handle('task_dependency', {
      action: 'remove',
      task_id: b.id,
      depends_on: a.id,
    }) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
  });

  it('rejects missing action', () => {
    expect(() => handle('task_dependency', { task_id: 1, depends_on: 2 })).toThrow(
      'action is required',
    );
  });
});

// =============================================================================
// task_add_artifact / task_get_artifacts
// =============================================================================

describe('task_add_artifact', () => {
  it('adds an artifact to a task', () => {
    const task = handle('task_create', { title: 'Art task' }) as { id: number };
    const artifact = handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'spec',
      content: 'The specification document.',
    }) as { id: number; name: string; content: string; created_by: string };
    expect(artifact.id).toBeGreaterThan(0);
    expect(artifact.name).toBe('spec');
    expect(artifact.content).toBe('The specification document.');
    expect(artifact.created_by).toBe('test-agent');
  });

  it('adds artifact to specific stage', () => {
    const task = handle('task_create', { title: 'Art task' }) as { id: number };
    const artifact = handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'review-notes',
      content: 'Looks good.',
      stage: 'review',
    }) as { stage: string };
    expect(artifact.stage).toBe('review');
  });

  it('rejects missing name', () => {
    const task = handle('task_create', { title: 'T' }) as { id: number };
    expect(() =>
      handle('task_artifact', { type: 'general', task_id: task.id, content: 'x' }),
    ).toThrow('"name" must be a non-empty');
  });

  it('rejects missing content', () => {
    const task = handle('task_create', { title: 'T' }) as { id: number };
    expect(() =>
      handle('task_artifact', { type: 'general', task_id: task.id, name: 'spec' }),
    ).toThrow('"content" must be a non-empty');
  });
});

describe('task_get_artifacts', () => {
  it('returns artifacts for a task', () => {
    const task = handle('task_create', { title: 'Art task' }) as { id: number };
    handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'spec',
      content: 'Spec v1',
    });
    handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'plan',
      content: 'Plan v1',
    });
    const artifacts = handle('task_query', { type: 'artifacts', task_id: task.id }) as unknown[];
    expect(artifacts).toHaveLength(2);
  });

  it('filters artifacts by stage', () => {
    const task = handle('task_create', { title: 'Art task' }) as { id: number };
    handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'spec',
      content: 'S',
      stage: 'spec',
    });
    handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'plan',
      content: 'P',
      stage: 'plan',
    });
    const artifacts = handle('task_query', {
      type: 'artifacts',
      task_id: task.id,
      stage: 'spec',
    }) as {
      name: string;
    }[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].name).toBe('spec');
  });

  it('rejects missing task_id', () => {
    expect(() => handle('task_query', { type: 'artifacts' })).toThrow('"task_id" is required');
  });
});

// =============================================================================
// task_pipeline_config
// =============================================================================

describe('task_pipeline_config', () => {
  it('gets default pipeline stages', () => {
    const result = handle('task_config', { action: 'pipeline' }) as { stages: string[] };
    expect(result.stages).toContain('backlog');
    expect(result.stages).toContain('done');
    expect(result.stages.length).toBeGreaterThanOrEqual(5);
  });

  it('sets custom stages for a project', () => {
    const customStages = ['todo', 'doing', 'done'];
    const result = handle('task_config', {
      action: 'pipeline',
      project: 'custom-proj',
      stages: customStages,
    }) as { stages: string[] };
    expect(result).toHaveProperty('stages');
    expect(Array.isArray((result as { stages: string[] }).stages)).toBe(true);

    const readBack = handle('task_config', { action: 'pipeline', project: 'custom-proj' }) as {
      stages: string[];
    };
    expect(readBack.stages).toEqual(customStages);
  });

  it('sets and reads gate_config', () => {
    handle('task_config', {
      action: 'pipeline',
      project: 'gate-proj',
      stages: ['backlog', 'spec', 'done'],
      gate_config: { require_comment: true, exempt_stages: ['backlog'] },
    });
    const config = handle('task_config', { action: 'pipeline', project: 'gate-proj' }) as {
      stages: string[];
      gate_config: { require_comment: boolean; exempt_stages: string[] };
    };
    expect(config.gate_config.require_comment).toBe(true);
    expect(config.gate_config.exempt_stages).toEqual(['backlog']);
  });

  it('returns default gate_config when none set', () => {
    const config = handle('task_config', { action: 'pipeline' }) as {
      gate_config: { require_comment: boolean };
    };
    expect(config.gate_config.require_comment).toBe(false);
  });
});

// =============================================================================
// task_comment / task_get_comments
// =============================================================================

describe('task_comment', () => {
  it('adds a comment to a task', () => {
    const task = handle('task_create', { title: 'Comment task' }) as { id: number };
    const comment = handle('task_comment', {
      task_id: task.id,
      content: 'Hello from test!',
    }) as { id: number; content: string; agent_id: string };
    expect(comment.id).toBeGreaterThan(0);
    expect(comment.content).toBe('Hello from test!');
    expect(comment.agent_id).toBe('test-agent');
  });

  it('adds a threaded reply', () => {
    const task = handle('task_create', { title: 'Thread task' }) as { id: number };
    const parent = handle('task_comment', {
      task_id: task.id,
      content: 'Root comment',
    }) as { id: number };
    const reply = handle('task_comment', {
      task_id: task.id,
      content: 'Reply to root',
      parent_comment_id: parent.id,
    }) as { parent_comment_id: number };
    expect(reply.parent_comment_id).toBe(parent.id);
  });

  it('rejects missing content', () => {
    const task = handle('task_create', { title: 'T' }) as { id: number };
    expect(() => handle('task_comment', { task_id: task.id })).toThrow(
      '"content" must be a non-empty',
    );
  });

  it('rejects missing task_id', () => {
    expect(() => handle('task_comment', { content: 'hello' })).toThrow('"task_id" is required');
  });
});

describe('task_get_comments', () => {
  it('returns comments for a task', () => {
    const task = handle('task_create', { title: 'Comment task' }) as { id: number };
    handle('task_comment', { task_id: task.id, content: 'First' });
    handle('task_comment', { task_id: task.id, content: 'Second' });
    const comments = handle('task_query', { type: 'comments', task_id: task.id }) as unknown[];
    expect(comments).toHaveLength(2);
  });

  it('returns empty array for task with no comments', () => {
    const task = handle('task_create', { title: 'No comments' }) as { id: number };
    const comments = handle('task_query', { type: 'comments', task_id: task.id }) as unknown[];
    expect(comments).toHaveLength(0);
  });

  it('respects limit parameter', () => {
    const task = handle('task_create', { title: 'Many comments' }) as { id: number };
    for (let i = 0; i < 5; i++) {
      handle('task_comment', { task_id: task.id, content: `Comment ${i}` });
    }
    const comments = handle('task_query', {
      type: 'comments',
      task_id: task.id,
      limit: 2,
    }) as unknown[];
    expect(comments).toHaveLength(2);
  });
});

// =============================================================================
// task_collaborator
// =============================================================================

describe('task_collaborator', () => {
  it('adds a collaborator with default role', () => {
    const task = handle('task_create', { title: 'Collab task' }) as { id: number };
    const collab = handle('task_collaborator', {
      action: 'add',
      task_id: task.id,
      agent_id: 'agent-2',
    }) as { agent_id: string; role: string };
    expect(collab.agent_id).toBe('agent-2');
    expect(collab.role).toBe('collaborator');
  });

  it('adds a reviewer', () => {
    const task = handle('task_create', { title: 'Review task' }) as { id: number };
    const collab = handle('task_collaborator', {
      action: 'add',
      task_id: task.id,
      agent_id: 'reviewer-1',
      role: 'reviewer',
    }) as { role: string };
    expect(collab.role).toBe('reviewer');
  });

  it('adds a watcher', () => {
    const task = handle('task_create', { title: 'Watch task' }) as { id: number };
    const collab = handle('task_collaborator', {
      action: 'add',
      task_id: task.id,
      agent_id: 'watcher-1',
      role: 'watcher',
    }) as { role: string };
    expect(collab.role).toBe('watcher');
  });

  it('rejects missing agent_id', () => {
    const task = handle('task_create', { title: 'T' }) as { id: number };
    expect(() => handle('task_collaborator', { action: 'add', task_id: task.id })).toThrow(
      '"agent_id" must be a non-empty',
    );
  });

  it('removes a collaborator', () => {
    const task = handle('task_create', { title: 'Collab task' }) as { id: number };
    handle('task_collaborator', { action: 'add', task_id: task.id, agent_id: 'agent-2' });
    const result = handle('task_collaborator', {
      action: 'remove',
      task_id: task.id,
      agent_id: 'agent-2',
    }) as { success: boolean };
    expect(result.success).toBe(true);
  });

  it('rejects missing agent_id on remove', () => {
    const task = handle('task_create', { title: 'T' }) as { id: number };
    expect(() => handle('task_collaborator', { action: 'remove', task_id: task.id })).toThrow(
      '"agent_id" must be a non-empty',
    );
  });

  it('rejects missing action', () => {
    const task = handle('task_create', { title: 'T' }) as { id: number };
    expect(() => handle('task_collaborator', { task_id: task.id, agent_id: 'a' })).toThrow(
      'action is required',
    );
  });
});

// =============================================================================
// task_search
// =============================================================================

describe('task_list search mode', () => {
  it('finds tasks by title', () => {
    handle('task_create', { title: 'Implement authentication module' });
    handle('task_create', { title: 'Fix database migration' });
    const results = handle('task_list', { query: 'authentication' }) as unknown[];
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('finds tasks by description', () => {
    handle('task_create', {
      title: 'Backend work',
      description: 'Need to refactor the authentication flow',
    });
    const results = handle('task_list', { query: 'authentication' }) as unknown[];
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for no matches', () => {
    handle('task_create', { title: 'Unrelated task' });
    const results = handle('task_list', { query: 'xyznonexistent' }) as unknown[];
    expect(results).toHaveLength(0);
  });

  it('filters search by project', () => {
    handle('task_create', { title: 'Auth in alpha', project: 'alpha' });
    handle('task_create', { title: 'Auth in beta', project: 'beta' });
    const results = handle('task_list', { query: 'Auth', project: 'alpha' }) as {
      task: { project: string };
    }[];
    for (const r of results) {
      expect(r.task.project).toBe('alpha');
    }
  });
});

// =============================================================================
// task_get_subtasks
// =============================================================================

describe('task_get_subtasks', () => {
  it('returns subtasks of a parent', () => {
    const parent = handle('task_create', { title: 'Parent' }) as { id: number };
    handle('task_create', { title: 'Child 1', parent_id: parent.id });
    handle('task_create', { title: 'Child 2', parent_id: parent.id });
    const subtasks = handle('task_query', { type: 'subtasks', task_id: parent.id }) as {
      title: string;
    }[];
    expect(subtasks).toHaveLength(2);
  });

  it('returns empty array for task with no subtasks', () => {
    const task = handle('task_create', { title: 'Leaf' }) as { id: number };
    const subtasks = handle('task_query', { type: 'subtasks', task_id: task.id }) as unknown[];
    expect(subtasks).toHaveLength(0);
  });

  it('rejects missing task_id', () => {
    expect(() => handle('task_query', { type: 'subtasks' })).toThrow('"task_id" is required');
  });
});

// =============================================================================
// task_approval
// =============================================================================

describe('task_approval', () => {
  it('creates an approval request', () => {
    const task = handle('task_create', { title: 'Approve me' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const approval = handle('task_approval', { action: 'request', task_id: task.id }) as {
      id: number;
      task_id: number;
      status: string;
    };
    expect(approval.id).toBeGreaterThan(0);
    expect(approval.task_id).toBe(task.id);
    expect(approval.status).toBe('pending');
  });

  it('creates approval for specific stage', () => {
    const task = handle('task_create', { title: 'Stage approval' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const approval = handle('task_approval', {
      action: 'request',
      task_id: task.id,
      stage: 'review',
    }) as { stage: string };
    expect(approval.stage).toBe('review');
  });

  it('assigns specific reviewer', () => {
    const task = handle('task_create', { title: 'Review assign' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const approval = handle('task_approval', {
      action: 'request',
      task_id: task.id,
      reviewer: 'senior-dev',
    }) as { reviewer: string };
    expect(approval.reviewer).toBe('senior-dev');
  });

  it('rejects nonexistent task for request', () => {
    expect(() => handle('task_approval', { action: 'request', task_id: 9999 })).toThrow();
  });

  it('approves a pending approval', () => {
    const task = handle('task_create', { title: 'Approve' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const approval = handle('task_approval', { action: 'request', task_id: task.id }) as {
      id: number;
    };
    const result = handle('task_approval', {
      action: 'approve',
      approval_id: approval.id,
      comment: 'Looks good!',
    }) as { status: string };
    expect(result.status).toBe('approved');
  });

  it('approves without comment', () => {
    const task = handle('task_create', { title: 'Approve' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const approval = handle('task_approval', { action: 'request', task_id: task.id }) as {
      id: number;
    };
    const result = handle('task_approval', { action: 'approve', approval_id: approval.id }) as {
      status: string;
    };
    expect(result.status).toBe('approved');
  });

  it('rejects missing approval_id on approve', () => {
    expect(() => handle('task_approval', { action: 'approve' })).toThrow(
      '"approval_id" is required',
    );
  });

  it('rejects a pending approval', () => {
    const task = handle('task_create', { title: 'Reject' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const approval = handle('task_approval', { action: 'request', task_id: task.id }) as {
      id: number;
    };
    const result = handle('task_approval', {
      action: 'reject',
      approval_id: approval.id,
      comment: 'Needs work',
    }) as { status: string };
    expect(result.status).toBe('rejected');
  });

  it('rejects and regresses task', () => {
    const task = handle('task_create', { title: 'Reject+Regress' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_stage', { action: 'advance', task_id: task.id, stage: 'review' });
    const approval = handle('task_approval', { action: 'request', task_id: task.id }) as {
      id: number;
    };
    handle('task_approval', {
      action: 'reject',
      approval_id: approval.id,
      comment: 'Rework needed',
      regress_to: 'implement',
    });
    const list = handle('task_list', { stage: 'implement' }) as { id: number }[];
    const found = list.find((t) => t.id === task.id);
    expect(found).not.toBeUndefined();
    expect(found!.id).toBe(task.id);
  });

  it('rejects missing comment on reject', () => {
    const task = handle('task_create', { title: 'T' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const approval = handle('task_approval', { action: 'request', task_id: task.id }) as {
      id: number;
    };
    expect(() => handle('task_approval', { action: 'reject', approval_id: approval.id })).toThrow(
      '"comment" must be a non-empty',
    );
  });

  it('lists pending approvals', () => {
    const task = handle('task_create', { title: 'Pending' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_approval', { action: 'request', task_id: task.id });
    const pending = handle('task_approval', { action: 'list' }) as unknown[];
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });

  it('filters pending by reviewer', () => {
    const task = handle('task_create', { title: 'Reviewer filter' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_approval', { action: 'request', task_id: task.id, reviewer: 'rev-agent' });
    const pending = handle('task_approval', { action: 'list', reviewer: 'rev-agent' }) as {
      reviewer: string;
    }[];
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty when no pending approvals', () => {
    const pending = handle('task_approval', { action: 'list' }) as unknown[];
    expect(pending).toHaveLength(0);
  });

  it('review approves and advances task', () => {
    const task = handle('task_create', { title: 'Review cycle' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_stage', { action: 'advance', task_id: task.id, stage: 'review' });
    const result = handle('task_approval', {
      action: 'review',
      task_id: task.id,
      decision: 'approve',
    }) as { success: boolean; action: string; task: { stage: string } };
    expect(result.success).toBe(true);
    expect(result.action).toBe('approved');
    expect(result.task.stage).toBe('done');
  });

  it('review rejects and regresses task to implement', () => {
    const task = handle('task_create', { title: 'Review reject' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_stage', { action: 'advance', task_id: task.id, stage: 'review' });
    const result = handle('task_approval', {
      action: 'review',
      task_id: task.id,
      decision: 'reject',
      reason: 'Tests are failing',
    }) as { success: boolean; action: string; task: { stage: string } };
    expect(result.success).toBe(true);
    expect(result.action).toBe('rejected');
    expect(result.task.stage).toBe('implement');
  });

  it('review rejects to custom stage', () => {
    const task = handle('task_create', { title: 'Review custom regress' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_stage', { action: 'advance', task_id: task.id, stage: 'review' });
    const result = handle('task_approval', {
      action: 'review',
      task_id: task.id,
      decision: 'reject',
      reason: 'Spec was wrong',
      regress_to: 'spec',
    }) as { task: { stage: string } };
    expect(result.task.stage).toBe('spec');
  });

  it('review rejects reject without reason', () => {
    const task = handle('task_create', { title: 'No reason' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_stage', { action: 'advance', task_id: task.id, stage: 'review' });
    expect(() =>
      handle('task_approval', { action: 'review', task_id: task.id, decision: 'reject' }),
    ).toThrow('"reason" must be a non-empty');
  });

  it('review rejects invalid decision', () => {
    const task = handle('task_create', { title: 'Bad action' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    expect(() =>
      handle('task_approval', { action: 'review', task_id: task.id, decision: 'maybe' }),
    ).toThrow('Invalid decision');
  });

  it('review rejects nonexistent task', () => {
    expect(() =>
      handle('task_approval', { action: 'review', task_id: 9999, decision: 'approve' }),
    ).toThrow();
  });

  it('review rejects missing decision', () => {
    const task = handle('task_create', { title: 'T' }) as { id: number };
    expect(() => handle('task_approval', { action: 'review', task_id: task.id })).toThrow(
      '"decision" must be a non-empty',
    );
  });
});

// =============================================================================
// task_generate_rules
// =============================================================================

describe('task_generate_rules', () => {
  it('generates mdc format rules', () => {
    const result = handle('task_config', { action: 'rules', format: 'mdc' }) as { rules: string };
    expect(result.rules).toContain('Pipeline Workflow');
    expect(result.rules).toContain('alwaysApply: true');
    expect(result.rules).toContain('task_next');
    expect(result.rules).toContain('backlog');
  });

  it('generates claude_md format rules', () => {
    const result = handle('task_config', { action: 'rules', format: 'claude_md' }) as {
      rules: string;
    };
    expect(result.rules).toContain('## Pipeline Tasks');
    expect(result.rules).toContain('task_claim');
    expect(result.rules).toContain('task_stage');
  });

  it('includes project name in mdc rules', () => {
    const result = handle('task_config', {
      action: 'rules',
      format: 'mdc',
      project: 'my-proj',
    }) as {
      rules: string;
    };
    expect(result.rules).toContain('my-proj');
  });

  it('includes project name in claude_md rules', () => {
    const result = handle('task_config', {
      action: 'rules',
      format: 'claude_md',
      project: 'my-proj',
    }) as { rules: string };
    expect(result.rules).toContain('my-proj');
  });

  it('uses custom pipeline stages in rules', () => {
    handle('task_config', {
      action: 'pipeline',
      project: 'custom',
      stages: ['todo', 'doing', 'done'],
    });
    const result = handle('task_config', { action: 'rules', format: 'mdc', project: 'custom' }) as {
      rules: string;
    };
    expect(result.rules).toContain('todo');
    expect(result.rules).toContain('doing');
  });

  it('rejects invalid format', () => {
    expect(() => handle('task_config', { action: 'rules', format: 'invalid' })).toThrow(
      'Format must be "mdc" or "claude_md"',
    );
  });

  it('rejects missing format', () => {
    expect(() => handle('task_config', { action: 'rules' })).toThrow(
      '"format" must be a non-empty',
    );
  });
});

// =============================================================================
// Integration: full pipeline flow
// =============================================================================

describe('integration: full pipeline flow', () => {
  it('create -> claim -> advance through stages -> add artifacts -> complete', () => {
    const task = handle('task_create', {
      title: 'Full pipeline integration test',
      description: 'Test the entire pipeline flow',
      priority: 50,
      project: 'integration',
      tags: ['test', 'pipeline'],
    }) as { id: number; stage: string; status: string };
    expect(task.stage).toBe('backlog');
    expect(task.status).toBe('pending');

    handle('task_claim', { task_id: task.id });

    handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'spec',
      content: 'Specification for the feature.',
      stage: 'spec',
    });

    handle('task_stage', { action: 'advance', task_id: task.id });

    handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'plan',
      content: 'Implementation plan with milestones.',
      stage: 'plan',
    });

    handle('task_stage', { action: 'advance', task_id: task.id });

    handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'code-summary',
      content: 'Implemented feature X with 500 LOC.',
      stage: 'implement',
    });

    handle('task_stage', { action: 'advance', task_id: task.id });

    handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'test-results',
      content: '15 tests passed, 0 failed.',
      stage: 'test',
    });

    handle('task_stage', { action: 'advance', task_id: task.id });

    handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'review-notes',
      content: 'Code reviewed and approved.',
      stage: 'review',
    });

    const completed = handle('task_stage', {
      action: 'complete',
      task_id: task.id,
      result: 'Feature fully implemented and reviewed.',
    }) as { status: string; stage: string };
    expect(completed.status).toBe('completed');

    const artifacts = handle('task_query', { type: 'artifacts', task_id: task.id }) as unknown[];
    expect(artifacts).toHaveLength(5);
  });

  it('create with dependencies -> unblock -> advance', () => {
    const dep = handle('task_create', { title: 'Dependency' }) as { id: number };
    const task = handle('task_create', { title: 'Blocked task' }) as { id: number };
    handle('task_dependency', { action: 'add', task_id: task.id, depends_on: dep.id });

    handle('task_claim', { task_id: dep.id });
    handle('task_stage', { action: 'complete', task_id: dep.id, result: 'Dep done' });

    handle('task_claim', { task_id: task.id });
    const advanced = handle('task_stage', { action: 'advance', task_id: task.id }) as {
      stage: string;
    };
    expect(advanced.stage).toBe('plan');
  });

  it('multi-agent collaboration flow', () => {
    const task = handle('task_create', { title: 'Collab flow' }) as { id: number };

    handle('task_collaborator', {
      action: 'add',
      task_id: task.id,
      agent_id: 'dev-agent',
      role: 'collaborator',
    });
    handle('task_collaborator', {
      action: 'add',
      task_id: task.id,
      agent_id: 'review-agent',
      role: 'reviewer',
    });
    handle('task_collaborator', {
      action: 'add',
      task_id: task.id,
      agent_id: 'pm-agent',
      role: 'watcher',
    });

    handle('task_claim', { task_id: task.id, claimer: 'dev-agent' });

    handle('task_comment', { task_id: task.id, content: 'Starting implementation' });
    handle('task_comment', { task_id: task.id, content: 'Need clarification on auth flow' });

    handle('task_stage', { action: 'advance', task_id: task.id, stage: 'review' });

    handle('task_config', { action: 'session', id: 'reviewer', name: 'review-agent' });
    const reviewed = handle('task_approval', {
      action: 'review',
      task_id: task.id,
      decision: 'approve',
    }) as { success: boolean; task: { stage: string } };
    expect(reviewed.success).toBe(true);
    expect(reviewed.task.stage).toBe('done');

    const comments = handle('task_query', { type: 'comments', task_id: task.id }) as unknown[];
    expect(comments).toHaveLength(2);
  });

  it('review rejection cycle: review -> reject -> rework -> re-review -> approve', () => {
    const task = handle('task_create', { title: 'Review cycle test' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_stage', { action: 'advance', task_id: task.id, stage: 'review' });

    const rejected = handle('task_approval', {
      action: 'review',
      task_id: task.id,
      decision: 'reject',
      reason: 'Missing error handling',
      regress_to: 'implement',
    }) as { task: { stage: string } };
    expect(rejected.task.stage).toBe('implement');

    handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'fix-notes',
      content: 'Added error handling for edge cases.',
      stage: 'implement',
    });
    handle('task_stage', { action: 'advance', task_id: task.id, stage: 'review' });

    const approved = handle('task_approval', {
      action: 'review',
      task_id: task.id,
      decision: 'approve',
    }) as { task: { stage: string } };
    expect(approved.task.stage).toBe('done');
  });

  it('subtask workflow: parent with children', () => {
    const parent = handle('task_create', {
      title: 'Epic: User authentication',
      project: 'auth',
    }) as { id: number };
    const sub1 = handle('task_create', {
      title: 'Login form UI',
      parent_id: parent.id,
      project: 'auth',
    }) as { id: number };
    const sub2 = handle('task_create', {
      title: 'Auth API endpoints',
      parent_id: parent.id,
      project: 'auth',
    }) as { id: number };

    const subtasks = handle('task_query', { type: 'subtasks', task_id: parent.id }) as {
      id: number;
    }[];
    expect(subtasks).toHaveLength(2);

    handle('task_claim', { task_id: sub1.id });
    handle('task_stage', { action: 'complete', task_id: sub1.id, result: 'Login UI done' });
    handle('task_claim', { task_id: sub2.id });
    handle('task_stage', { action: 'complete', task_id: sub2.id, result: 'API endpoints done' });

    handle('task_claim', { task_id: parent.id });
    handle('task_stage', { action: 'complete', task_id: parent.id, result: 'Auth epic complete' });

    const list = handle('task_list', { project: 'auth', status: 'completed' }) as unknown[];
    expect(list).toHaveLength(3);
  });
});

// =============================================================================
// Session-aware behavior
// =============================================================================

describe('session-aware behavior', () => {
  it('claims use session name when claimer not specified', () => {
    handle('task_config', { action: 'session', id: 's1', name: 'agent-alpha' });
    const task = handle('task_create', { title: 'Session claim' }) as { id: number };
    const claimed = handle('task_claim', { task_id: task.id }) as { assigned_to: string };
    expect(claimed.assigned_to).toBe('agent-alpha');
  });

  it('comments use session name as agent_id', () => {
    handle('task_config', { action: 'session', id: 's2', name: 'agent-beta' });
    const task = handle('task_create', { title: 'Session comment' }) as { id: number };
    const comment = handle('task_comment', {
      task_id: task.id,
      content: 'Test',
    }) as { agent_id: string };
    expect(comment.agent_id).toBe('agent-beta');
  });

  it('artifacts use session name as created_by', () => {
    handle('task_config', { action: 'session', id: 's3', name: 'agent-gamma' });
    const task = handle('task_create', { title: 'Session artifact' }) as { id: number };
    const artifact = handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'test',
      content: 'data',
    }) as { created_by: string };
    expect(artifact.created_by).toBe('agent-gamma');
  });

  it('session can be changed mid-flow', () => {
    handle('task_config', { action: 'session', id: 's4', name: 'first-agent' });
    const task = handle('task_create', { title: 'Switch' }) as {
      id: number;
      created_by: string;
    };
    expect(task.created_by).toBe('first-agent');

    handle('task_config', { action: 'session', id: 's5', name: 'second-agent' });
    const comment = handle('task_comment', {
      task_id: task.id,
      content: 'From second',
    }) as { agent_id: string };
    expect(comment.agent_id).toBe('second-agent');
  });
});

// =============================================================================
// task_expand
// =============================================================================

// =============================================================================
// task_cleanup
// =============================================================================

describe('task_cleanup', () => {
  it('returns cleanup results', () => {
    const result = handle('task_config', { action: 'cleanup' }) as {
      purgedTasks: number;
      purgedComments: number;
      purgedApprovals: number;
    };
    expect(result.purgedTasks).toBeGreaterThanOrEqual(0);
    expect(result.purgedComments).toBeGreaterThanOrEqual(0);
    expect(result.purgedApprovals).toBeGreaterThanOrEqual(0);
  });

  it('does not purge recent completed tasks', () => {
    const task = handle('task_create', { title: 'Complete me' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_stage', { action: 'complete', task_id: task.id, result: 'Done' });

    const result = handle('task_config', { action: 'cleanup' }) as { purgedTasks: number };
    expect(result.purgedTasks).toBe(0);
  });
});

// =============================================================================
// task_decision
// =============================================================================

describe('task_decision', () => {
  it('creates a decision artifact with chose/over/because', () => {
    const task = handle('task_create', { title: 'Decide something' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const artifact = handle('task_artifact', {
      type: 'decision',
      task_id: task.id,
      chose: 'PostgreSQL',
      over: 'MySQL, SQLite',
      because: 'Better JSON support and extensibility',
    }) as { name: string; content: string; stage: string };
    expect(artifact.name).toBe('decision');
  });

  it('stores decision at current task stage', () => {
    const task = handle('task_create', { title: 'Stage decision' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_stage', { action: 'advance', task_id: task.id, stage: 'implement' });
    const artifact = handle('task_artifact', {
      type: 'decision',
      task_id: task.id,
      chose: 'REST',
      over: 'GraphQL',
      because: 'Simpler for this use case',
    }) as { stage: string };
    expect(artifact.stage).toBe('implement');
  });

  it('contains structured markdown with Chose/Over/Because', () => {
    const task = handle('task_create', { title: 'Structured decision' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const artifact = handle('task_artifact', {
      type: 'decision',
      task_id: task.id,
      chose: 'TypeScript',
      over: 'JavaScript',
      because: 'Type safety',
    }) as { content: string };
    expect(artifact.content).toContain('**Chose:** TypeScript');
    expect(artifact.content).toContain('**Over:** JavaScript');
    expect(artifact.content).toContain('**Because:** Type safety');
  });

  it('rejects decision on non-existent task', () => {
    expect(() =>
      handle('task_artifact', {
        type: 'decision',
        task_id: 99999,
        chose: 'A',
        over: 'B',
        because: 'C',
      }),
    ).toThrow('not found');
  });

  it('increments version for multiple decisions on same task', () => {
    const task = handle('task_create', { title: 'Multi decision' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const d1 = handle('task_artifact', {
      type: 'decision',
      task_id: task.id,
      chose: 'Option A',
      over: 'Option B',
      because: 'Reason 1',
    }) as { version: number };
    const d2 = handle('task_artifact', {
      type: 'decision',
      task_id: task.id,
      chose: 'Option C',
      over: 'Option D',
      because: 'Reason 2',
    }) as { version: number };
    expect(d1.version).toBe(1);
    expect(d2.version).toBe(2);
  });
});

// =============================================================================
// Consolidated tool: task_stage
// =============================================================================

describe('task_stage', () => {
  it('advances task to next stage', () => {
    const task = handle('task_create', { title: 'Stage advance' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const advanced = handle('task_stage', { action: 'advance', task_id: task.id }) as {
      stage: string;
    };
    expect(advanced.stage).toBe('plan');
  });

  it('advances to a specific stage', () => {
    const task = handle('task_create', { title: 'Stage skip' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const advanced = handle('task_stage', {
      action: 'advance',
      task_id: task.id,
      stage: 'implement',
    }) as { stage: string };
    expect(advanced.stage).toBe('implement');
  });

  it('advances with inline comment', () => {
    const task = handle('task_create', { title: 'Stage comment' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_stage', { action: 'advance', task_id: task.id, comment: 'Spec done' });
    const comments = handle('task_query', { type: 'comments', task_id: task.id }) as Array<{
      content: string;
    }>;
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe('Spec done');
  });

  it('regresses task to earlier stage', () => {
    const task = handle('task_create', { title: 'Stage regress' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    handle('task_stage', { action: 'advance', task_id: task.id, stage: 'implement' });
    const regressed = handle('task_stage', {
      action: 'regress',
      task_id: task.id,
      stage: 'spec',
    }) as { stage: string };
    expect(regressed.stage).toBe('spec');
  });

  it('completes a task', () => {
    const task = handle('task_create', { title: 'Stage complete' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const result = handle('task_stage', {
      action: 'complete',
      task_id: task.id,
      result: 'All done',
    }) as { status: string; result: string };
    expect(result.status).toBe('completed');
    expect(result.result).toBe('All done');
  });

  it('fails a task', () => {
    const task = handle('task_create', { title: 'Stage fail' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const result = handle('task_stage', {
      action: 'fail',
      task_id: task.id,
      result: 'Error occurred',
    }) as { status: string };
    expect(result.status).toBe('failed');
  });

  it('cancels a task', () => {
    const task = handle('task_create', { title: 'Stage cancel' }) as { id: number };
    const result = handle('task_stage', {
      action: 'cancel',
      task_id: task.id,
      reason: 'No longer needed',
    }) as { status: string };
    expect(result.status).toBe('cancelled');
  });

  it('rejects missing action', () => {
    expect(() => handle('task_stage', { task_id: 1 })).toThrow('action is required');
  });

  it('rejects invalid action', () => {
    expect(() => handle('task_stage', { action: 'bogus', task_id: 1 })).toThrow('Invalid action');
  });
});

// =============================================================================
// Consolidated tool: task_query
// =============================================================================

describe('task_query', () => {
  it('returns subtasks of a parent', () => {
    const parent = handle('task_create', { title: 'Parent' }) as { id: number };
    handle('task_create', { title: 'Child 1', parent_id: parent.id });
    handle('task_create', { title: 'Child 2', parent_id: parent.id });
    const subtasks = handle('task_query', { type: 'subtasks', task_id: parent.id }) as {
      title: string;
    }[];
    expect(subtasks).toHaveLength(2);
  });

  it('returns artifacts for a task', () => {
    const task = handle('task_create', { title: 'Art task' }) as { id: number };
    handle('task_artifact', { type: 'general', task_id: task.id, name: 'spec', content: 'S' });
    handle('task_artifact', { type: 'general', task_id: task.id, name: 'plan', content: 'P' });
    const artifacts = handle('task_query', { type: 'artifacts', task_id: task.id }) as unknown[];
    expect(artifacts).toHaveLength(2);
  });

  it('filters artifacts by stage', () => {
    const task = handle('task_create', { title: 'Art stage' }) as { id: number };
    handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'spec',
      content: 'S',
      stage: 'spec',
    });
    handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'plan',
      content: 'P',
      stage: 'plan',
    });
    const artifacts = handle('task_query', {
      type: 'artifacts',
      task_id: task.id,
      stage: 'spec',
    }) as { name: string }[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].name).toBe('spec');
  });

  it('returns comments for a task', () => {
    const task = handle('task_create', { title: 'Comment task' }) as { id: number };
    handle('task_comment', { task_id: task.id, content: 'First' });
    handle('task_comment', { task_id: task.id, content: 'Second' });
    const comments = handle('task_query', { type: 'comments', task_id: task.id }) as unknown[];
    expect(comments).toHaveLength(2);
  });

  it('respects comment limit', () => {
    const task = handle('task_create', { title: 'Many' }) as { id: number };
    for (let i = 0; i < 5; i++) {
      handle('task_comment', { task_id: task.id, content: `C${i}` });
    }
    const comments = handle('task_query', {
      type: 'comments',
      task_id: task.id,
      limit: 2,
    }) as unknown[];
    expect(comments).toHaveLength(2);
  });

  it('rejects missing type', () => {
    expect(() => handle('task_query', { task_id: 1 })).toThrow('type is required');
  });
});

// =============================================================================
// Consolidated tool: task_artifact
// =============================================================================

describe('task_artifact', () => {
  it('adds a general artifact', () => {
    const task = handle('task_create', { title: 'Artifact task' }) as { id: number };
    const artifact = handle('task_artifact', {
      type: 'general',
      task_id: task.id,
      name: 'spec',
      content: 'The specification.',
    }) as { name: string; content: string; created_by: string };
    expect(artifact.name).toBe('spec');
    expect(artifact.content).toBe('The specification.');
    expect(artifact.created_by).toBe('test-agent');
  });

  it('creates a decision artifact', () => {
    const task = handle('task_create', { title: 'Decision task' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const artifact = handle('task_artifact', {
      type: 'decision',
      task_id: task.id,
      chose: 'PostgreSQL',
      over: 'MySQL',
      because: 'Better JSON support',
    }) as { name: string; content: string };
    expect(artifact.name).toBe('decision');
    expect(artifact.content).toContain('**Chose:** PostgreSQL');
  });

  it('creates a learning artifact', () => {
    const task = handle('task_create', { title: 'Learning task' }) as { id: number };
    handle('task_claim', { task_id: task.id });
    const result = handle('task_artifact', {
      type: 'learning',
      task_id: task.id,
      content: 'Always validate inputs',
      category: 'technique',
    }) as { name: string; content: string };
    expect(result.name).toBe('learning');
    expect(result.content).toContain('Always validate inputs');
  });

  it('rejects missing type', () => {
    expect(() => handle('task_artifact', { task_id: 1 })).toThrow('type is required');
  });
});

// =============================================================================
// Consolidated tool: task_config
// =============================================================================

describe('task_config', () => {
  it('gets default pipeline config', () => {
    const result = handle('task_config', { action: 'pipeline' }) as { stages: string[] };
    expect(result.stages).toContain('backlog');
    expect(result.stages).toContain('done');
  });

  it('sets custom pipeline stages', () => {
    handle('task_config', {
      action: 'pipeline',
      project: 'cfg-test',
      stages: ['todo', 'doing', 'done'],
    });
    const result = handle('task_config', { action: 'pipeline', project: 'cfg-test' }) as {
      stages: string[];
    };
    expect(result.stages).toEqual(['todo', 'doing', 'done']);
  });

  it('sets session identity', () => {
    const result = handle('task_config', {
      action: 'session',
      id: 'cfg-id',
      name: 'cfg-agent',
    }) as { success: boolean; name: string };
    expect(result.success).toBe(true);
    expect(result.name).toBe('cfg-agent');
  });

  it('runs cleanup', () => {
    const result = handle('task_config', { action: 'cleanup' }) as { purgedTasks: number };
    expect(result.purgedTasks).toBeGreaterThanOrEqual(0);
  });

  it('generates rules', () => {
    const result = handle('task_config', { action: 'rules', format: 'mdc' }) as {
      rules: string;
    };
    expect(result.rules).toContain('Pipeline Workflow');
  });

  it('rejects missing action', () => {
    expect(() => handle('task_config', {})).toThrow('action is required');
  });
});
