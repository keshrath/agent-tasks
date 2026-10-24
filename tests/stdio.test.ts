// =============================================================================
// The entry point over stdio — a real child process: initialize, a tool call,
// the REST server it starts once the client is initialized, and its exit (the
// port freed) when the client closes stdin
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';

const ROOT = join(import.meta.dirname, '..');
let child: ChildProcessWithoutNullStreams | null = null;
let dir = '';

afterEach(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child!.once('exit', r));
    child.kill();
    await exited;
  }
  child = null;
  // Windows frees the DB file a moment after the process exits.
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

describe('agent-tasks over stdio', () => {
  it('initializes, answers a tool call, serves REST once initialized, exits when stdin closes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-tasks-stdio-'));
    const port = await freePort();
    child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'index.ts')], {
      cwd: ROOT,
      env: {
        ...process.env,
        AGENT_TASKS_DB: join(dir, 'tasks.db'),
        AGENT_TASKS_PORT: String(port),
        AGENT_COMM_URL: 'http://127.0.0.1:1',
        AGENT_KNOWLEDGE_URL: 'http://127.0.0.1:1',
      },
    });
    const replies = new Map<number, (m: Record<string, unknown>) => void>();
    createInterface({ input: child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (typeof msg.id === 'number') replies.get(msg.id)?.(msg);
    });
    let id = 0;
    const rpc = (method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        replies.set(++id, resolve);
        child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });

    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stdio-test', version: '1' },
    });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('agent-tasks');

    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );

    const created = await rpc('tools/call', {
      name: 'task_create',
      arguments: { title: 'Over stdio' },
    });
    const text = (created.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain('"title": "Over stdio"');
    expect(text).toContain('PIPELINE: Tasks flow through stages');

    let health: Response | null = null;
    for (let i = 0; i < 50 && !health; i++) {
      health = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      if (!health) await new Promise((r) => setTimeout(r, 100));
    }
    expect(await health!.json()).toMatchObject({ status: 'ok', tasks: 1 });

    const exited = new Promise<number | null>((r) => child!.once('exit', r));
    child.stdin.end();
    expect(await exited).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
