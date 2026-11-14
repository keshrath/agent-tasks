// =============================================================================
// Every MCP tool and action through the real Claude Code CLI
// (AGENT_TASKS_E2E_CLAUDE=1, `npm run e2e:claude`): `claude -p` with this
// checkout's dist/index.js as its only MCP server, on a scratch database and
// port. Each step asks the model for exact tool calls, checks that it made them
// (stream-json tool_use events) and then reads the database itself.
//
// Isolation: `--setting-sources project,local` keeps the user's settings
// (hooks, plugins, env) out, `--strict-mcp-config` their MCP servers; the
// scratch cwd has no CLAUDE.md. AGENT_TASKS_E2E_MODEL picks the model (haiku).
// =============================================================================

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../../src/storage/database.js';
import { DIST, NOWHERE, freePort } from './harness.js';

const E2E = process.env.AGENT_TASKS_E2E_CLAUDE === '1';
const MODEL = process.env.AGENT_TASKS_E2E_MODEL ?? 'haiku';
vi.setConfig({ testTimeout: 4 * 60_000 });

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
}

let dir = '';
let config = '';
let db: Db;

/** Runs one `claude -p` turn; returns the agent-tasks tool calls it made, in order. */
function ask(prompt: string): Promise<ToolCall[]> {
  return new Promise((resolve, reject) => {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const child = spawn(
      exe,
      [
        '-p',
        prompt,
        '--model',
        MODEL,
        '--mcp-config',
        config,
        '--strict-mcp-config',
        '--setting-sources',
        'project,local',
        '--allowedTools',
        'mcp__agent-tasks',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
      ],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err || out.slice(-2000)}`));
      const calls = new Map<string, ToolCall>();
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line) as {
          type: string;
          message?: { content?: Array<Record<string, unknown>> };
        };
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'tool_use' && String(block.name).startsWith('mcp__agent-tasks__')) {
            calls.set(String(block.id), {
              name: String(block.name).slice('mcp__agent-tasks__'.length),
              input: block.input as Record<string, unknown>,
              result: '',
              isError: false,
            });
          }
          if (block.type === 'tool_result' && calls.has(String(block.tool_use_id))) {
            const call = calls.get(String(block.tool_use_id))!;
            const content = block.content;
            call.result = Array.isArray(content)
              ? content.map((c: { text?: string }) => c.text ?? '').join('')
              : String(content ?? '');
            call.isError = block.is_error === true;
          }
        }
      }
      resolve([...calls.values()]);
    });
  });
}

const STRICT =
  'Use only the agent-tasks MCP tools. Make exactly the tool calls listed, in order, with exactly ' +
  'the arguments given (numbers as numbers), and nothing else. Then reply "done".\n';

interface Row {
  id: number;
  title: string;
  status: string;
  stage: string;
  project: string | null;
  priority: number;
  assigned_to: string | null;
  created_by: string;
  parent_id: number | null;
  result: string | null;
}

const task = (title: string) => db.queryOne<Row>(`SELECT * FROM tasks WHERE title = ?`, [title])!;

describe.skipIf(!E2E)('every MCP tool through claude -p', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-tasks-mcp-e2e-'));
    const path = join(dir, 'tasks.db');
    config = join(dir, 'mcp.json');
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          'agent-tasks': {
            command: process.execPath,
            args: [join(DIST, 'index.js')],
            env: {
              AGENT_TASKS_DB: path,
              AGENT_TASKS_PORT: String(await freePort()),
              AGENT_COMM_URL: NOWHERE,
              AGENT_KNOWLEDGE_URL: NOWHERE,
            },
          },
        },
      }),
    );
    db = createDb({ path });
  });

  afterAll(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('task_config session, task_create (with a subtask), task_get', async () => {
    const calls = await ask(
      STRICT +
        '1. task_config {"action":"session","id":"e2e-1","name":"e2e-agent"}\n' +
        '2. task_create {"title":"E2E parent","project":"e2e","priority":4,"tags":["mcp","e2e"],"description":"made by claude -p"}\n' +
        '3. task_create {"title":"E2E child","parent_id":<the id returned by step 2>}\n' +
        '4. task_get {"task_id":<the id from step 2>,"include":["subtasks","comments","artifacts"]}',
    );
    expect(calls.map((c) => c.name)).toEqual([
      'task_config',
      'task_create',
      'task_create',
      'task_get',
    ]);
    expect(calls.every((c) => !c.isError)).toBe(true);
    const parent = task('E2E parent');
    expect(parent).toMatchObject({
      project: 'e2e',
      priority: 4,
      created_by: 'e2e-agent',
      stage: 'backlog',
      status: 'pending',
    });
    expect(task('E2E child')).toMatchObject({ parent_id: parent.id, project: 'e2e', priority: 4 });
    expect(calls[3]!.result).toContain('E2E child');
    expect(calls[1]!.result).toContain('PIPELINE: Tasks flow through stages');
  });

  it('task_list: by project, by tags, by query, and next', async () => {
    const calls = await ask(
      STRICT +
        '1. task_list {"project":"e2e"}\n' +
        '2. task_list {"tags":["mcp"]}\n' +
        '3. task_list {"query":"parent"}\n' +
        '4. task_list {"next":true}',
    );
    expect(calls.map((c) => c.name)).toEqual(['task_list', 'task_list', 'task_list', 'task_list']);
    expect(calls[0]!.result).toContain('E2E child');
    expect(calls[1]!.result).toContain('E2E parent');
    expect(calls[1]!.result).not.toContain('E2E child');
    expect(calls[2]!.result).toContain('E2E parent');
    expect(calls[3]!.result).toContain('E2E parent');
  });

  it('task_update: metadata and a blocks dependency; then a dependency refusal', async () => {
    const parent = task('E2E parent');
    const child = task('E2E child');
    const calls = await ask(
      STRICT +
        `1. task_update {"task_id":${parent.id},"title":"E2E parent v2","priority":6}\n` +
        `2. task_stage {"action":"claim","task_id":${child.id},"claimer":"e2e-agent"}\n` +
        `3. task_update {"task_id":${child.id},"dependency":{"action":"add","depends_on":${parent.id},"relationship":"blocks"}}\n` +
        `4. task_stage {"action":"advance","task_id":${child.id}}  (this one is expected to fail; report its error)`,
    );
    expect(calls.map((c) => c.name)).toEqual([
      'task_update',
      'task_stage',
      'task_update',
      'task_stage',
    ]);
    expect(task('E2E parent v2')).toMatchObject({ id: parent.id, priority: 6 });
    expect(
      db.queryAll(
        `SELECT * FROM task_dependencies WHERE task_id = ? AND depends_on = ? AND relationship = 'blocks'`,
        [child.id, parent.id],
      ),
    ).toHaveLength(1);
    expect(task('E2E child')).toMatchObject({ status: 'in_progress', stage: 'spec' });
    expect(
      db.queryOne<{ holder: string }>(`SELECT holder FROM tasks WHERE id = ?`, [child.id])!.holder,
    ).toMatch(/^mcp:/);
    expect(calls[3]!.isError).toBe(true);
    expect(calls[3]!.result).toContain('Blocked by incomplete dependencies');
  });

  it('task_stage: claim, advance, regress, complete; assign; fail; cancel', async () => {
    const parent = task('E2E parent v2');
    const calls = await ask(
      STRICT +
        `1. task_stage {"action":"claim","task_id":${parent.id},"claimer":"e2e-agent"}\n` +
        `2. task_stage {"action":"advance","task_id":${parent.id}}\n` +
        `3. task_stage {"action":"advance","task_id":${parent.id},"stage":"test"}\n` +
        `4. task_stage {"action":"regress","task_id":${parent.id},"stage":"implement","reason":"tests missing"}\n` +
        `5. task_stage {"action":"complete","task_id":${parent.id},"result":"shipped by e2e"}\n` +
        '6. task_create {"title":"E2E assign"}\n' +
        '7. task_stage {"action":"assign","task_id":<id from step 6>,"claimer":"e2e-other"}\n' +
        '8. task_stage {"action":"fail","task_id":<id from step 6>,"result":"could not reproduce"}\n' +
        '9. task_create {"title":"E2E cancel"}\n' +
        '10. task_stage {"action":"cancel","task_id":<id from step 9>,"reason":"duplicate"}',
    );
    expect(calls.map((c) => c.name)).toEqual([
      'task_stage',
      'task_stage',
      'task_stage',
      'task_stage',
      'task_stage',
      'task_create',
      'task_stage',
      'task_stage',
      'task_create',
      'task_stage',
    ]);
    expect(calls.filter((c) => c.isError)).toEqual([]);
    expect(task('E2E parent v2')).toMatchObject({
      status: 'completed',
      stage: 'done',
      assigned_to: 'e2e-agent',
      result: 'shipped by e2e',
    });
    expect(task('E2E assign')).toMatchObject({
      status: 'failed',
      assigned_to: 'e2e-other',
      result: 'could not reproduce',
    });
    expect(task('E2E cancel')).toMatchObject({ status: 'cancelled', result: 'duplicate' });
  });

  it('task_artifact: general, decision, learning, comment and a threaded reply', async () => {
    const child = task('E2E child');
    const calls = await ask(
      STRICT +
        `1. task_artifact {"type":"general","task_id":${child.id},"name":"spec","content":"# Spec\\nfrom e2e"}\n` +
        `2. task_artifact {"type":"decision","task_id":${child.id},"chose":"SQLite","over":"Postgres","because":"local first"}\n` +
        `3. task_artifact {"type":"learning","task_id":${child.id},"content":"WAL keeps readers unblocked","category":"technique"}\n` +
        `4. task_artifact {"type":"comment","task_id":${child.id},"content":"top comment"}\n` +
        `5. task_artifact {"type":"comment","task_id":${child.id},"content":"a reply","parent_comment_id":<the comment id from step 4>}`,
    );
    expect(calls.map((c) => c.name)).toEqual(Array(5).fill('task_artifact'));
    expect(calls.filter((c) => c.isError)).toEqual([]);
    const artifacts = db.queryAll<{ name: string; content: string }>(
      `SELECT name, content FROM task_artifacts WHERE task_id = ? ORDER BY id`,
      [child.id],
    );
    expect(artifacts.map((a) => a.name)).toEqual(['spec', 'decision', 'learning']);
    expect(artifacts[0]!.content).toContain('from e2e');
    expect(artifacts[1]!.content).toContain('SQLite');
    const comments = db.queryAll<{ id: number; content: string; parent_comment_id: number | null }>(
      `SELECT id, content, parent_comment_id FROM task_comments WHERE task_id = ? ORDER BY id`,
      [child.id],
    );
    expect(comments.map((c) => c.content)).toEqual(['top comment', 'a reply']);
    expect(comments[1]!.parent_comment_id).toBe(comments[0]!.id);
  });

  it('task_config pipeline with a gate, its refusal on advance and complete, cleanup, rules', async () => {
    const calls = await ask(
      STRICT +
        '1. task_config {"action":"pipeline","project":"gated","stages":["todo","doing","done"],"gate_config":{"require_comment":true}}\n' +
        '2. task_config {"action":"pipeline","project":"gated"}\n' +
        '3. task_create {"title":"E2E gated","project":"gated"}\n' +
        '4. task_stage {"action":"claim","task_id":<id from step 3>,"claimer":"e2e-agent"}\n' +
        '5. task_stage {"action":"complete","task_id":<id from step 3>,"result":"too early"}  (expected to fail)\n' +
        '6. task_stage {"action":"advance","task_id":<id from step 3>,"comment":"reviewed"}\n' +
        '7. task_config {"action":"cleanup"}\n' +
        '8. task_config {"action":"rules","format":"claude_md"}',
    );
    expect(calls.map((c) => c.name)).toEqual([
      'task_config',
      'task_config',
      'task_create',
      'task_stage',
      'task_stage',
      'task_stage',
      'task_config',
      'task_config',
    ]);
    expect(calls[1]!.result).toContain('doing');
    expect(calls[4]!.isError).toBe(true);
    expect(calls[4]!.result).toContain('Stage gate');
    expect(
      db.queryOne<{ stages: string; gate_config: string }>(
        `SELECT stages, gate_config FROM pipeline_config WHERE project = 'gated'`,
      ),
    ).toMatchObject({ stages: JSON.stringify(['todo', 'doing', 'done']) });
    expect(task('E2E gated')).toMatchObject({ stage: 'done', status: 'completed' });
    expect(calls[7]!.result).toContain('task_stage');
  });

  it('task_delete, and a missing task named as not found', async () => {
    const cancel = task('E2E cancel');
    const calls = await ask(
      STRICT +
        `1. task_delete {"task_id":${cancel.id}}\n` +
        `2. task_get {"task_id":${cancel.id}}  (expected to fail)`,
    );
    expect(calls.map((c) => c.name)).toEqual(['task_delete', 'task_get']);
    expect(db.queryOne(`SELECT * FROM tasks WHERE id = ?`, [cancel.id])).toBeNull();
    expect(calls[1]!.isError).toBe(true);
    expect(calls[1]!.result).toBe(`Error [NOT_FOUND]: Task not found: ${cancel.id}`);
  });
});
