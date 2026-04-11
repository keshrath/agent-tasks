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
});

// Cleanup scratch dir after all tests in this file finish.
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // ignore — best-effort cleanup
  }
});
