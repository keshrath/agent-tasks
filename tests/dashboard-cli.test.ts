// =============================================================================
// `agent-tasks dashboard`: with nothing on the port it serves REST (and the
// dashboard) itself and prints the URL; with a server there it prints that
// server's URL and exits. --no-open keeps the browser shut.
// =============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const children: ChildProcessWithoutNullStreams[] = [];
let dir = '';

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (c) =>
        new Promise((resolve) => {
          if (c.exitCode !== null) return resolve(null);
          c.once('exit', resolve);
          c.kill();
        }),
    ),
  );
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function run(port: number): { child: ChildProcessWithoutNullStreams; line: Promise<string> } {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(ROOT, 'src', 'index.ts'), 'dashboard', '--no-open'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        AGENT_TASKS_DB: join(dir, 'tasks.db'),
        AGENT_TASKS_PORT: String(port),
        AGENT_COMM_URL: 'http://127.0.0.1:1',
        AGENT_KNOWLEDGE_URL: 'http://127.0.0.1:1',
      },
    },
  );
  children.push(child);
  const line = new Promise<string>((resolve) => {
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('\n')) resolve(out.split('\n')[0]!);
    });
  });
  return { child, line };
}

describe('agent-tasks dashboard', () => {
  it('serves the dashboard when nothing does, else points at the one that does', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-tasks-dashboard-'));
    const port = await freePort();
    const first = run(port);
    expect(await first.line).toBe(
      `agent-tasks dashboard: http://127.0.0.1:${port}/  (served by this process; Ctrl+C stops it)`,
    );
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>agent-tasks</title>');

    const second = run(port);
    expect(await second.line).toBe(`agent-tasks dashboard: http://127.0.0.1:${port}/`);
    const code = await new Promise((resolve) => second.child.on('exit', resolve));
    expect(code).toBe(0);
    expect(first.child.exitCode).toBeNull();
  }, 30_000);

  it('builds the URL from the port, never from what answers there (cmd would run it)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-tasks-dashboard-'));
    const foreign = createHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', dashboard_url: 'http://x/&calc' }));
    });
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    const { port } = foreign.address() as { port: number };
    try {
      const { child, line } = run(port);
      expect(await line).toBe(`agent-tasks dashboard: http://127.0.0.1:${port}/`);
      expect(await new Promise((resolve) => child.on('exit', resolve))).toBe(0);
    } finally {
      await new Promise((resolve) => foreign.close(resolve));
    }
  }, 30_000);
});
