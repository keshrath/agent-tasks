// =============================================================================
// The /pipeline pane when what serves it changes under it, in the real Claude
// Code CLI (AGENT_TASKS_E2E_CLAUDE=1, `npm run e2e:claude`): the MCP process
// serving REST exits and another takes the port over, the server goes away and
// comes back by itself (on the board and in a task's detail), and an
// agent-tasks from before the board holds the port. The pane recovers without
// a key wherever it can; where it cannot, it says why.
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ClaudeTerm,
  DIST,
  NOWHERE,
  SHOTS_DIR,
  freePort,
  killTree,
  landsOn,
  sleep,
  startWorld,
  statusEntry,
  until,
  type World,
} from './harness.js';
import { renderShots } from './render.js';

const E2E = process.env.AGENT_TASKS_E2E_CLAUDE === '1';
const MIN = 60_000;
vi.setConfig({ testTimeout: 3 * MIN });

const FULLSCREEN = { CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1' };

const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0' },
  },
})}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`;

async function answers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) }))
      .ok;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => Promise<boolean> | boolean, what: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(200);
  }
  throw new Error(`never: ${what}`);
}

describe.skipIf(!E2E)('the /pipeline pane when its server changes', () => {
  let w: World;
  let t: ClaudeTerm | null = null;
  const children: ChildProcess[] = [];

  /** A session's MCP server on `port`: it serves REST once its client initializes. */
  function mcp(port: number): ChildProcess {
    const child = spawn(process.execPath, [join(DIST, 'index.js')], {
      env: {
        ...w.env,
        AGENT_TASKS_DB: w.db,
        AGENT_TASKS_PORT: String(port),
        AGENT_COMM_URL: NOWHERE,
        AGENT_KNOWLEDGE_URL: NOWHERE,
      },
      windowsHide: true,
    });
    child.stdout?.resume();
    child.stderr?.resume();
    child.stdin?.write(INITIALIZE);
    children.push(child);
    return child;
  }

  /** A standalone REST server on `port` over the world's database. */
  function serve(port: number): ChildProcess {
    const child = spawn(
      process.execPath,
      [join(DIST, 'server.js'), '--port', String(port), '--db', w.db],
      { env: w.env, windowsHide: true },
    );
    child.stdout?.resume();
    child.stderr?.resume();
    children.push(child);
    return child;
  }

  async function term(env: Record<string, string> = {}, ready?: RegExp) {
    t = new ClaudeTerm(w, 120, 40, { ...FULLSCREEN, ...env });
    await t.start(ready);
    return t;
  }

  beforeAll(async () => {
    w = await startWorld();
  }, 2 * MIN);
  afterEach(async () => {
    await t?.kill();
    t = null;
    for (const c of children.splice(0)) killTree(c.pid);
  }, MIN);
  afterAll(async () => {
    await w?.stop();
    await renderShots(SHOTS_DIR);
  }, 2 * MIN);

  it('the session serving REST exits: another takes the port over and the pane carries on by itself', async () => {
    const port = await freePort();
    const first = mcp(port);
    await waitUntil(() => answers(port), `the first session serves :${port}`);
    mcp(port);
    const t = await term({ AGENT_TASKS_PORT: String(port) });
    await t.pipeline();
    await t.waitFor(/Backlog \d+/);
    expect(statusEntry(t)).toMatch(/\d+ open tasks/);

    killTree(first.pid);
    await waitUntil(() => answers(port), 'a second session takes the port over', 30_000);
    await waitUntil(
      () => /Backlog \d+/.test(t.text()) && /\d+ open tasks/.test(statusEntry(t) ?? ''),
      'the pane shows the board again',
      30_000,
    );
    expect(t.text()).not.toMatch(/not reachable/);
    t.shot('takeover-board');

    await t.key('ESC');
    await t.pipeline(String(w.ids.flaky));
    await t.waitFor(/Investigate flaky knowledge sync on Windows/);
    await t.focus('Comment');
    await t.type('After the takeover.');
    await t.enter();
    await t.waitFor(/Comments 1/);
    const { comments } = await w.api<{ comments: { content: string }[] }>(
      'GET',
      `/api/tasks/${w.ids.flaky}?include=comments`,
    );
    expect(comments.at(-1)?.content).toBe('After the takeover.');
  });

  it('the server goes away and comes back: down and up again without a key', async () => {
    const t = await term();
    await t.pipeline();
    await t.waitFor(/Backlog \d+/);

    await w.stopServer();
    const down = await t.waitFor(/not reachable/, 20_000);
    expect(down).not.toMatch(/Backlog \d+/);
    await waitUntil(() => statusEntry(t) === 'offline', 'the status entry says offline');
    await landsOn(t, 'Refresh');

    await t.key('ESC');
    await t.pipeline();
    const asked = await t.waitFor(/nothing answers at http:\/\/127\.0\.0\.1:\d+/);
    expect(asked).toMatch(/not reachable/);
    await landsOn(t, 'Refresh');

    await w.startServer();
    await t.waitFor(/Backlog \d+/, 20_000);
    await waitUntil(
      () => /\d+ open tasks/.test(statusEntry(t) ?? ''),
      'the status entry counts again',
    );
    expect(t.text()).not.toMatch(/not reachable|still no board/);
    // Back without a key, the ring is on a task again, not left on a tab where Enter does nothing.
    await landsOn(t, /^[○●!] #\d+ /);
  });

  it('down while a task is open: back up, the same task is shown again', async () => {
    const t = await term();
    await t.pipeline(String(w.ids.pane));
    await t.waitFor(/#\d+ Replace the web dashboard/);
    await t.waitFor(/Advance ›/);

    await w.stopServer();
    await t.waitFor(/not reachable/, 20_000);
    await w.startServer();
    await t.key('r');
    const back = await t.waitFor(/#\d+ Replace the web dashboard/, 20_000);
    expect(back).toMatch(/‹ Board/);
    await landsOn(t, /Advance › \w+/);
    const stage = (await w.task(w.ids.pane)).stage;
    await t.enter();
    await until(w, w.ids.pane, (x) => x.stage !== stage);
  });

  it('an agent-tasks from before the board holds the port: the pane says which, then takes the new one', async () => {
    const port = await freePort();
    const old: Server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') res.end(JSON.stringify({ status: 'ok', version: '1.10.13' }));
      else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });
    await new Promise<void>((r) => old.listen(port, '127.0.0.1', r));
    try {
      const t = await term({ AGENT_TASKS_PORT: String(port) }, /agent-tasks: old server/);
      await t.pipeline();
      const s = await t.waitFor(/An older agent-tasks \(1\.10\.13\) holds the port/);
      // The command's answer wraps in the transcript column: its lines joined, left of the pane.
      const answer = s
        .split('\n')
        .map((l) => l.split('│')[0])
        .join(' ')
        .replace(/\s+/g, ' ');
      expect(answer).toMatch(
        /agent-tasks: version 1\.10\.13 holds http:\/\/127\.0\.0\.1:\d+ and has no board: end the sessions still running it/,
      );
      expect(s).not.toMatch(/Backlog \d+/);
      expect(statusEntry(t)).toBe('old server 1.10.13 on the port');
      await landsOn(t, 'Refresh');
      t.shot('old-server');

      await new Promise<void>((r) => old.close(() => r()));
      serve(port);
      await waitUntil(() => answers(port), 'the current server holds the port');
      await t.key('r');
      await t.waitFor(/Backlog \d+/, 20_000);
      await waitUntil(() => /\d+ open tasks/.test(statusEntry(t) ?? ''), 'the counts are back');
    } finally {
      old.close();
    }
  });
});
