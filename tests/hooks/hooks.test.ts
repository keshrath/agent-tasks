// =============================================================================
// Hook script unit tests
//
// Spawns each script in scripts/hooks/ as a child process with crafted
// stdin, asserts it fails open and emits shape-correct JSON for the Claude
// Code hook schema. Covers all five hooks: session-start, task-cleanup-start,
// task-cleanup-stop, pipeline-enforcer, todowrite-bridge.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createContext } from '../../src/context.js';
import { startRestServer } from '../../src/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOKS_DIR = join(__dirname, '..', '..', 'scripts', 'hooks');

interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json: unknown;
}

function runHook(
  script: string,
  stdinInput: unknown,
  { timeoutMs = 5000, env = {} }: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(HOOKS_DIR, script)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`hook ${script} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trimmed = stdout.trim();
      let json: unknown = null;
      if (trimmed) {
        try {
          json = JSON.parse(trimmed);
        } catch (err) {
          reject(new Error(`${script}: non-JSON stdout: ${trimmed}\n${(err as Error).message}`));
          return;
        }
      }
      resolve({ code, stdout: trimmed, stderr, json });
    });

    if (stdinInput !== null && stdinInput !== undefined) {
      child.stdin.write(typeof stdinInput === 'string' ? stdinInput : JSON.stringify(stdinInput));
    }
    child.stdin.end();
  });
}

// Dev-null DB paths for tests so we never touch the real files.
const scratch = mkdtempSync(join(tmpdir(), 'agent-tasks-hooks-'));
const isolatedEnv = {
  AGENT_COMM_DB: join(scratch, 'agent-comm.db'),
  AGENT_TASKS_DB: join(scratch, 'agent-tasks.db'),
  AGENT_TASKS_URL: 'http://127.0.0.1:1',
};

// ---------------------------------------------------------------------------
// session-start.js
// ---------------------------------------------------------------------------

describe('session-start.js', () => {
  it('emits SessionStart hookSpecificOutput', async () => {
    const { code, json } = await runHook('session-start.js', {});
    expect(code).toBe(0);
    const obj = json as { hookSpecificOutput?: { hookEventName?: string } };
    expect(obj.hookSpecificOutput?.hookEventName).toBe('SessionStart');
  });
});

// ---------------------------------------------------------------------------
// task-cleanup-start.js
// ---------------------------------------------------------------------------

describe('task-cleanup-start.js', () => {
  it('exits 0 on empty stdin (no DB present)', async () => {
    const { code, json } = await runHook('task-cleanup-start.js', '', { env: isolatedEnv });
    expect(code).toBe(0);
    expect(json).toEqual({});
  });

  it('exits 0 on non-JSON stdin', async () => {
    const { code, json } = await runHook('task-cleanup-start.js', 'junk', { env: isolatedEnv });
    expect(code).toBe(0);
    expect(json).toEqual({});
  });

  it('fails only idle tasks whose assignee is neither online nor heartbeating', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-tasks-start-'));
    try {
      const ctx = createContext({ path: join(dir, 'agent-tasks.db') });
      const ids: Record<string, number> = {};
      for (const who of ['online', 'beating', 'gone', 'gone-but-busy', 'unclaimed']) {
        ids[who] = ctx.tasks.create({ title: who }, 'test').id;
        if (who !== 'unclaimed') ctx.tasks.claim(ids[who]!, who === 'gone-but-busy' ? 'gone' : who);
      }
      ctx.db.run(`UPDATE tasks SET updated_at = datetime('now', '-3 hours') WHERE id != ?`, [
        ids['gone-but-busy'],
      ]);
      ctx.close();
      const comm = new Database(join(dir, 'agent-comm.db'));
      comm.exec(`CREATE TABLE agents (name TEXT, status TEXT, last_heartbeat TEXT)`);
      comm.exec(`INSERT INTO agents VALUES
        ('online', 'online', datetime('now', '-2 days')),
        ('beating', 'offline', datetime('now', '-1 minutes')),
        ('gone', 'offline', datetime('now', '-2 days'))`);
      comm.close();

      const { code, json } = await runHook('task-cleanup-start.js', '{}', {
        env: {
          ...isolatedEnv,
          AGENT_TASKS_DB: join(dir, 'agent-tasks.db'),
          AGENT_COMM_DB: join(dir, 'agent-comm.db'),
        },
      });

      expect(code).toBe(0);
      expect(json).toEqual({});
      const db = new Database(join(dir, 'agent-tasks.db'), { readonly: true });
      const rows = db.prepare('SELECT title, status, result FROM tasks').all() as {
        title: string;
        status: string;
        result: string | null;
      }[];
      db.close();
      expect(Object.fromEntries(rows.map((r) => [r.title, r.status]))).toEqual({
        online: 'in_progress',
        beating: 'in_progress',
        gone: 'failed',
        'gone-but-busy': 'in_progress',
        unclaimed: 'pending',
      });
      expect(rows.find((r) => r.title === 'gone')?.result).toContain('no longer running');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// task-cleanup-stop.js
// ---------------------------------------------------------------------------

describe('task-cleanup-stop.js', () => {
  it('exits 0 on empty stdin', async () => {
    const { code } = await runHook('task-cleanup-stop.js', '', { env: isolatedEnv });
    expect(code).toBe(0);
  });

  it('exits 0 on non-JSON stdin', async () => {
    const { code } = await runHook('task-cleanup-stop.js', 'junk', { env: isolatedEnv });
    expect(code).toBe(0);
  });

  function seed(dir: string): { live: number; dead: number } {
    const ctx = createContext({ path: join(dir, 'agent-tasks.db') });
    const live = ctx.tasks.create({ title: 'Live' }, 'test').id;
    const dead = ctx.tasks.create({ title: 'Dead' }, 'test').id;
    ctx.tasks.claim(live, 'alive-agent');
    ctx.tasks.claim(dead, 'gone-agent');
    ctx.close();
    return { live, dead };
  }

  function statuses(dir: string): Record<number, string> {
    const db = new Database(join(dir, 'agent-tasks.db'), { readonly: true });
    const rows = db.prepare('SELECT id, status FROM tasks').all() as {
      id: number;
      status: string;
    }[];
    db.close();
    return Object.fromEntries(rows.map((r) => [r.id, r.status]));
  }

  it('fails only the tasks of agents not online in AGENT_COMM_DB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-tasks-stop-'));
    try {
      const { live, dead } = seed(dir);
      const comm = new Database(join(dir, 'agent-comm.db'));
      comm.exec(`CREATE TABLE agents (name TEXT, status TEXT)`);
      comm.exec(`INSERT INTO agents VALUES ('alive-agent', 'online'), ('gone-agent', 'offline')`);
      comm.close();
      const env = {
        ...isolatedEnv,
        AGENT_TASKS_DB: join(dir, 'agent-tasks.db'),
        AGENT_COMM_DB: join(dir, 'agent-comm.db'),
      };

      const { code, json } = await runHook('task-cleanup-stop.js', '{}', { env });

      expect(code).toBe(0);
      expect((json as { reason?: string }).reason).toContain(`#${dead}`);
      expect(statuses(dir)).toEqual({ [live]: 'in_progress', [dead]: 'failed' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails nothing when the agent-comm DB cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-tasks-stop-'));
    try {
      const { live, dead } = seed(dir);
      const env = { ...isolatedEnv, AGENT_TASKS_DB: join(dir, 'agent-tasks.db') };

      const { code, json } = await runHook('task-cleanup-stop.js', '{}', { env });

      expect(code).toBe(0);
      expect(json).toEqual({});
      expect(statuses(dir)).toEqual({ [live]: 'in_progress', [dead]: 'in_progress' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// pipeline-enforcer.mjs
// ---------------------------------------------------------------------------

describe('pipeline-enforcer.mjs', () => {
  it('exits 0 on empty stdin', async () => {
    const { code, json } = await runHook('pipeline-enforcer.mjs', '', { env: isolatedEnv });
    expect(code).toBe(0);
    expect(json).toEqual({});
  });

  it('exits 0 on non-JSON stdin', async () => {
    const { code, json } = await runHook('pipeline-enforcer.mjs', 'not json', {
      env: isolatedEnv,
    });
    expect(code).toBe(0);
    expect(json).toEqual({});
  });

  it('ignores greetings', async () => {
    const { json } = await runHook(
      'pipeline-enforcer.mjs',
      { prompt: 'hello there' },
      { env: isolatedEnv },
    );
    expect(json).toEqual({});
  });

  it('ignores slash commands', async () => {
    const { json } = await runHook(
      'pipeline-enforcer.mjs',
      { prompt: '/commit' },
      { env: isolatedEnv },
    );
    expect(json).toEqual({});
  });

  it('ignores short questions', async () => {
    const { json } = await runHook(
      'pipeline-enforcer.mjs',
      { prompt: 'what is this?' },
      { env: isolatedEnv },
    );
    expect(json).toEqual({});
  });

  it('ignores system-reminder blocks', async () => {
    const { json } = await runHook(
      'pipeline-enforcer.mjs',
      {
        prompt:
          '<system-reminder>long injected context about tool usage and rules across the whole session</system-reminder>',
      },
      { env: isolatedEnv },
    );
    expect(json).toEqual({});
  });

  it('work prompt without registered agent emits UserPromptSubmit context', async () => {
    const { json } = await runHook(
      'pipeline-enforcer.mjs',
      {
        prompt:
          'refactor the authentication module to use JWT tokens instead of sessions across all endpoints and update the test suite',
      },
      { env: isolatedEnv },
    );
    const obj = json as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(obj.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expect(obj.hookSpecificOutput?.additionalContext).toMatch(/PIPELINE REQUIRED/);
  });

  function world(): { dir: string; env: Record<string, string>; taskId: number } {
    const dir = mkdtempSync(join(tmpdir(), 'agent-tasks-enforcer-'));
    const ctx = createContext({ path: join(dir, 'agent-tasks.db') });
    const taskId = ctx.tasks.create({ title: 'Work' }, 'test').id;
    ctx.close();
    const comm = new Database(join(dir, 'agent-comm.db'));
    comm.exec(`CREATE TABLE agents (name TEXT, status TEXT, last_heartbeat TEXT)`);
    comm.exec(`INSERT INTO agents VALUES ('worker', 'online', datetime('now'))`);
    comm.close();
    return {
      dir,
      taskId,
      env: {
        ...isolatedEnv,
        AGENT_TASKS_DB: join(dir, 'agent-tasks.db'),
        AGENT_COMM_DB: join(dir, 'agent-comm.db'),
      },
    };
  }

  const WORK = {
    prompt:
      'refactor the authentication module to use JWT tokens instead of sessions across all endpoints and update the test suite',
  };

  it('names the registered session without a task, and the real tool to claim with', async () => {
    const w = world();
    try {
      const { json } = await runHook('pipeline-enforcer.mjs', WORK, { env: w.env });
      const text = (json as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext;
      expect(text).toContain('Session "worker" has no active pipeline task.');
      expect(text).toContain('task_stage action "claim"');
      expect(text).not.toContain('task_claim');
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it('stays quiet once the session holds a task', async () => {
    const w = world();
    try {
      const ctx = createContext({ path: w.env.AGENT_TASKS_DB });
      ctx.tasks.claim(w.taskId, 'worker');
      ctx.close();
      const { json } = await runHook('pipeline-enforcer.mjs', WORK, { env: w.env });
      expect(json).toEqual({});
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// todowrite-bridge.mjs
// ---------------------------------------------------------------------------

describe('todowrite-bridge.mjs', () => {
  it('exits 0 on empty stdin', async () => {
    const { code, json } = await runHook('todowrite-bridge.mjs', '', { env: isolatedEnv });
    expect(code).toBe(0);
    expect(json).toEqual({});
  });

  it('exits 0 on non-JSON stdin', async () => {
    const { code, json } = await runHook('todowrite-bridge.mjs', 'junk', { env: isolatedEnv });
    expect(code).toBe(0);
    expect(json).toEqual({});
  });

  it('non-TodoWrite tool → {}', async () => {
    const { json } = await runHook(
      'todowrite-bridge.mjs',
      { tool_name: 'Bash', tool_input: {} },
      { env: isolatedEnv },
    );
    expect(json).toEqual({});
  });

  it('TodoWrite with pending todos → {} even when server unreachable', async () => {
    const { code, json } = await runHook(
      'todowrite-bridge.mjs',
      {
        tool_name: 'TodoWrite',
        tool_input: {
          todos: [
            { id: '1', content: 'do a thing', status: 'pending', priority: 'high' },
            { id: '2', content: 'already done', status: 'completed' },
          ],
        },
      },
      { env: isolatedEnv, timeoutMs: 10000 },
    );
    expect(code).toBe(0);
    expect(json).toEqual({});
  });

  it('turns open todos into tasks through the REST server, through its request guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-tasks-todo-'));
    const ctx = createContext({ path: join(dir, 'agent-tasks.db') });
    const server = await startRestServer(ctx, 0);
    try {
      const { code, json } = await runHook(
        'todowrite-bridge.mjs',
        {
          tool_name: 'TodoWrite',
          tool_input: {
            todos: [
              { id: '1', content: 'write the guard', status: 'pending', priority: 'high' },
              { id: '2', content: 'test it', status: 'in_progress', priority: 'low' },
              { id: '3', content: 'already done', status: 'completed' },
            ],
          },
        },
        { env: { ...isolatedEnv, AGENT_TASKS_URL: `http://localhost:${server.port}` } },
      );
      expect(code).toBe(0);
      expect(json).toEqual({});
      const tasks = ctx.tasks.list({ project: 'claude-todos' });
      expect(
        tasks.map((t) => [t.title, t.priority, t.created_by]).sort((a, b) => b[1] - a[1]),
      ).toEqual([
        ['write the guard', 5, 'todowrite-bridge'],
        ['test it', 1, 'todowrite-bridge'],
      ]);
    } finally {
      server.close();
      ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Cleanup scratch dir after all tests in this file finish.
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // ignore — best-effort cleanup
  }
});
