// =============================================================================
// The plugin's session hooks through the real Claude Code CLI
// (AGENT_TASKS_E2E_CLAUDE=1, `npm run e2e:claude`): `claude -p` with a scratch
// copy of plugin/ (--plugin-dir) whose .mcp.json runs this checkout on a scratch
// database and port. A claim the model makes is held by the session, the session
// ending ends its holder, and the enforcePipeline option's reminder reaches the
// model only when the session holds no open task.
//
// Isolation: `--setting-sources project,local` keeps the user's settings out, and
// `--allowedTools` lets the model call only the plugin's tools (`-p` drops a
// plugin's MCP server under `--strict-mcp-config`, so that flag is not used). The
// plugin option comes from `--settings` (a plugin's options are not read from
// project settings).
// AGENT_TASKS_E2E_MODEL picks the model (haiku).
// =============================================================================

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContext, type AppContext } from '../../src/context.js';
import { HolderService } from '../../src/domain/holders.js';
import { startRestServer, type RestServer } from '../../src/server.js';
import {
  ClaudeTerm,
  DIST,
  NOWHERE,
  ROOT,
  freePort,
  sleep,
  startWorld,
  type World,
} from './harness.js';

const E2E = process.env.AGENT_TASKS_E2E_CLAUDE === '1';
const MODEL = process.env.AGENT_TASKS_E2E_MODEL ?? 'haiku';
vi.setConfig({ testTimeout: 4 * 60_000 });

let dir = '';
let pluginDir = '';
let port = 0;
let ctx: AppContext;
let rest: RestServer;

interface Run {
  sessionId: string;
  text: string;
  claims: number;
  /** Every tool the model called, by name. */
  tools: string[];
}

/**
 * One `claude -p` turn with the plugin under test; `enforce` sets its enforcePipeline
 * option, `tools` adds to what the model may call, `at` is the port the plugin reads.
 */
function ask(
  prompt: string,
  enforce: boolean,
  {
    tools = [],
    at = port,
    resume,
    debug,
  }: { tools?: string[]; at?: number; resume?: string; debug?: string } = {},
): Promise<Run> {
  const settings = join(dir, 'settings.json');
  writeFileSync(
    settings,
    JSON.stringify({
      pluginConfigs: { 'agent-tasks@inline': { options: { enforcePipeline: enforce } } },
    }),
  );
  return new Promise((resolve, reject) => {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const child = spawn(
      exe,
      [
        '-p',
        prompt,
        '--model',
        MODEL,
        '--plugin-dir',
        pluginDir,
        '--setting-sources',
        'project,local',
        '--settings',
        settings,
        '--allowedTools',
        ['mcp__plugin_agent-tasks_agent-tasks', ...tools].join(','),
        '--output-format',
        'stream-json',
        '--verbose',
        ...(resume ? ['--resume', resume] : []),
        ...(debug ? ['--debug-file', debug] : []),
      ],
      {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, AGENT_TASKS_PORT: String(at) },
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err || out.slice(-2000)}`));
      const run: Run = { sessionId: '', text: '', claims: 0, tools: [] };
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line) as {
          type: string;
          session_id?: string;
          result?: string;
          message?: { content?: Array<Record<string, unknown>> };
        };
        if (ev.session_id) run.sessionId = ev.session_id;
        if (ev.type === 'result') run.text = String(ev.result ?? '');
        for (const block of ev.message?.content ?? []) {
          if (block.type !== 'tool_use') continue;
          run.tools.push(String(block.name));
          if (String(block.name).endsWith('__task_stage')) run.claims += 1;
        }
      }
      resolve(run);
    });
  });
}

const holderOf = (id: number) =>
  ctx.db.queryOne<{ holder: string | null }>(`SELECT holder FROM tasks WHERE id = ?`, [id])!.holder;
const holderRow = (id: string) =>
  ctx.db.queryOne<{ ended_at: string | null }>(`SELECT ended_at FROM holders WHERE id = ?`, [id]);

/** A work prompt the model answers in a word, calling nothing. */
const WORK =
  'Refactor the session handling of this project so it reads more clearly. ' +
  'For this test only, reply with the word done and nothing else. Do not call any tool.';

/**
 * Whether the reminder reached the model with the turn of `prompt`: read from the session's
 * own transcript (the hook's context is stored with the turn), not from the model's answer,
 * which a model can word as it likes.
 */
function sentReminder(run: Run, prompt: string): boolean {
  const store = join(homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  const rows = readFileSync(join(store, `${run.sessionId}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; attachment?: { type?: string } });
  const turn = rows.findLastIndex(
    (r) => r.type === 'user' && JSON.stringify(r).includes(prompt.slice(0, 60)),
  );
  if (turn < 0) throw new Error(`no turn of "${prompt.slice(0, 60)}" in ${run.sessionId}`);
  const end = rows.findIndex((r, k) => k > turn && r.type === 'assistant');
  return rows
    .slice(turn + 1, end < 0 ? undefined : end)
    .some(
      (r) =>
        r.attachment?.type === 'hook_additional_context' &&
        JSON.stringify(r).includes('holds no claimed agent-tasks task'),
    );
}

describe.skipIf(!E2E)('the plugin session hooks through claude -p', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-tasks-session-e2e-'));
    const db = join(dir, 'tasks.db');
    port = await freePort();
    pluginDir = join(dir, 'plugin');
    cpSync(join(ROOT, 'plugin'), pluginDir, {
      recursive: true,
      filter: (src) => !src.startsWith(join(ROOT, 'plugin', 'tests')),
    });
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'agent-tasks': {
            command: process.execPath,
            args: [join(DIST, 'index.js')],
            env: {
              AGENT_TASKS_DB: db,
              AGENT_TASKS_PORT: String(port),
              AGENT_COMM_URL: NOWHERE,
              AGENT_KNOWLEDGE_URL: NOWHERE,
            },
          },
        },
      }),
    );
    ctx = createContext({ path: db });
    // The REST port is served from outside the session, as another session's MCP
    // process serves it in use: up before this session's first prompt, and after it ends.
    rest = await startRestServer(ctx, port);
  });

  afterAll(() => {
    rest?.close();
    ctx?.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('a claim the model makes is held by its session, and the session ending ends the holder', async () => {
    const task = ctx.tasks.create({ title: 'E2E held claim' }, 'e2e');
    const run = await ask(
      `Call the agent-tasks task_stage tool once with {"action":"claim","task_id":${task.id},"claimer":"e2e-agent"} (task_id as a number). Then reply "done".`,
      false,
    );
    expect(run.claims).toBe(1);
    expect(run.sessionId).not.toBe('');
    expect(ctx.tasks.getById(task.id)).toMatchObject({
      status: 'in_progress',
      assigned_to: 'e2e-agent',
    });
    const holder = `claude:${run.sessionId}`;
    expect(holderOf(task.id)).toBe(holder);
    expect(holderRow(holder)?.ended_at).toBeTruthy();
    // Within the grace the task stays; past it, the next sweep fails it with the reason.
    expect(ctx.holders.sweep()).toEqual([]);
    ctx.db.run(`UPDATE holders SET ended_at = datetime('now', '-1 hour') WHERE id = ?`, [holder]);
    expect(ctx.holders.sweep().map((t) => t.id)).toEqual([task.id]);
    expect(ctx.tasks.getById(task.id)!.result).toBe(
      'The session holding this task ended without completing it (e2e-agent).',
    );
  });

  it('a claim the model makes without naming itself is made as its client and project, never as system', async () => {
    const task = ctx.tasks.create({ title: 'E2E unnamed claim' }, 'e2e');
    const run = await ask(
      `Call the agent-tasks task_stage tool once with {"action":"claim","task_id":${task.id}} (task_id as a number, no other arguments). Then reply "done".`,
      false,
    );
    expect(run.claims).toBe(1);
    expect(ctx.tasks.getById(task.id)).toMatchObject({
      status: 'in_progress',
      holder: `claude:${run.sessionId}`,
    });
    expect(ctx.tasks.getById(task.id)!.assigned_to).toBe(`claude-code@${basename(dir)}`);
  });

  it('with enforcePipeline, a work prompt in a session holding no task carries the reminder', async () => {
    const run = await ask(WORK, true);
    expect(sentReminder(run, WORK)).toBe(true);
  });

  it('without enforcePipeline, the same prompt carries nothing; the session was a holder from its start to its end', async () => {
    const run = await ask(WORK, false);
    expect(sentReminder(run, WORK)).toBe(false);
    expect(run.tools).toEqual([]);
    const row = ctx.db.queryOne<{ seen_at: string; ended_at: string | null }>(
      `SELECT seen_at, ended_at FROM holders WHERE id = ?`,
      [`claude:${run.sessionId}`],
    );
    expect(row).not.toBeNull();
    expect(row!.ended_at).not.toBeNull();
  });

  it('with enforcePipeline, a session that holds a task is not reminded; resumed, it holds it again', async () => {
    const task = ctx.tasks.create({ title: 'E2E holds one' }, 'e2e');
    const first = await ask(
      `Call the agent-tasks task_stage tool once with {"action":"claim","task_id":${task.id},"claimer":"e2e-agent"} (task_id as a number). Then reply "done".`,
      true,
    );
    expect(first.claims).toBe(1);
    const holder = `claude:${first.sessionId}`;
    expect(holderOf(task.id)).toBe(holder);
    expect(holderRow(holder)?.ended_at).toBeTruthy();
    const next = await ask(WORK, true, { resume: first.sessionId });
    expect(next.sessionId).toBe(first.sessionId);
    expect(sentReminder(next, WORK)).toBe(false);
    expect(ctx.tasks.getById(task.id)!.status).toBe('in_progress');
  });

  it("the session's own task list (TaskCreate) stays its own: nothing is mirrored onto the board", async () => {
    const before = ctx.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks`)!.n;
    const run = await ask(
      'Use the TaskCreate tool once to add "E2E scratch todo" to your own task list, then reply done.',
      false,
      { tools: ['TaskCreate'] },
    );
    expect(run.tools).toContain('TaskCreate');
    expect(ctx.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks`)!.n).toBe(before);
  });

  it('a REST server that hangs: no hook of the plugin waits past its timeout; a new conversation is still reminded', async () => {
    const hung: Server = createServer((socket) => socket.on('error', () => {}));
    const at = await freePort();
    await new Promise<void>((r) => hung.listen(at, '127.0.0.1', () => r()));
    const log = join(dir, 'hung-debug.log');
    try {
      const run = await ask(WORK, true, { at, debug: log });
      // A new conversation holds nothing: the reminder needs no answer from the server.
      expect(sentReminder(run, WORK)).toBe(true);
      // tool.call is left out: its time includes the tool's own run.
      const settled = [
        ...readFileSync(log, 'utf8').matchAll(
          /hooks module agent-tasks@inline (session\.start|prompt\.context|prompt\.submit|session\.end) settled in ([\d.]+)ms/g,
        ),
      ].map((m) => ({ hook: m[1]!, ms: Number(m[2]) }));
      expect(settled.map((x) => x.hook)).toEqual(
        expect.arrayContaining(['session.start', 'prompt.context', 'prompt.submit']),
      );
      for (const x of settled)
        expect({ ...x, isQuick: x.ms < 4_500 }).toMatchObject({ isQuick: true });
    } finally {
      hung.close();
    }
  });
});

// ---------------------------------------------------------------------------
// An interactive session, idle for longer than the grace, keeps its claim; once
// it exits, the claim fails. The test sweeps with a one-minute grace; the
// session's own MCP process sweeps too, with the default ten.
// ---------------------------------------------------------------------------

const GRACE_MIN = 1;
const minutes = (n: number) => n * 60_000;

async function waitUntil(check: () => boolean, ms: number, t?: ClaudeTerm): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(
        `not within ${ms} ms: ${check}${
          t
            ? `
${t.screen()}`
            : ''
        }`,
      );
    await sleep(250);
  }
}

describe.skipIf(!E2E)('an interactive session that sits idle', () => {
  let world: World;
  let t: ClaudeTerm;
  let local: AppContext;
  let sweeper: HolderService;

  beforeAll(async () => {
    world = await startWorld(undefined, { bare: true });
    local = createContext({ path: world.db });
    sweeper = new HolderService(local.db, local.events, GRACE_MIN);
  });

  afterAll(async () => {
    await t?.kill();
    local?.close();
    await world?.stop();
  });

  const sessionHolder = () =>
    local.db.queryOne<{ id: string; seen_at: string; ended_at: string | null }>(
      `SELECT * FROM holders WHERE id LIKE 'claude:%'`,
    );

  it(
    'beats from its start, holds the claim its model makes through minutes idle, and loses it only after it exits',
    async () => {
      const task = local.tasks.create({ title: 'E2E idle claim' }, 'e2e');
      t = new ClaudeTerm(
        world,
        120,
        40,
        {},
        ['--model', MODEL, '--allowedTools', 'mcp__plugin_agent-tasks_agent-tasks'],
        true,
      );
      await t.start(/agent-tasks: /);
      // The session's MCP process is up (it beats as a holder of its own) before the prompt.
      await waitUntil(
        () => local.db.queryOne(`SELECT id FROM holders WHERE id LIKE 'mcp:%'`) !== null,
        60_000,
        t,
      );
      // session.start: the session is a holder before it has claimed anything.
      await waitUntil(() => sessionHolder() !== null, 20_000, t);
      expect(sessionHolder()!.ended_at).toBeNull();

      await t.type(
        `Call the agent-tasks task_stage tool once with {"action":"claim","task_id":${task.id},"claimer":"e2e-idle"} (task_id as a number), then reply done.`,
      );
      await t.key('ENTER');
      const holder = sessionHolder()!.id;
      // tool.call: the claim the model made is the session's.
      await waitUntil(() => local.tasks.getById(task.id)!.holder === holder, 120_000, t);
      expect(local.tasks.getById(task.id)).toMatchObject({
        status: 'in_progress',
        assigned_to: 'e2e-idle',
      });

      // Idle past twice the grace: no key, no tool call, no prompt. Sweeps keep finding it alive.
      const idleUntil = Date.now() + minutes(2 * GRACE_MIN) + 30_000;
      const beats = new Set<string>();
      while (Date.now() < idleUntil) {
        await sleep(15_000);
        beats.add(sessionHolder()!.seen_at);
        expect(sweeper.sweep()).toEqual([]);
        expect(local.tasks.getById(task.id)!.status).toBe('in_progress');
      }
      expect(beats.size).toBeGreaterThanOrEqual(4);

      // session.end: /exit ends the holder; within the grace the task stays.
      await t.type('/exit');
      await t.key('ENTER');
      await waitUntil(() => sessionHolder()!.ended_at !== null, 30_000, t);
      expect(sweeper.sweep()).toEqual([]);
      // Past the grace, the sweep fails it, saying why.
      await sleep(minutes(GRACE_MIN) + 5_000);
      expect(sweeper.sweep().map((x) => x.id)).toEqual([task.id]);
      expect(local.tasks.getById(task.id)!.result).toBe(
        'The session holding this task ended without completing it (e2e-idle).',
      );
    },
    minutes(8),
  );
});

// ---------------------------------------------------------------------------
// /clear starts a new session id in the same process: the claims of the old
// one carry over to it, so the sweep never fails work the person is still on.
// ---------------------------------------------------------------------------

describe.skipIf(!E2E)('a session the person clears', () => {
  let world: World;
  let t: ClaudeTerm;
  let local: AppContext;
  let sweeper: HolderService;

  beforeAll(async () => {
    world = await startWorld(undefined, { bare: true });
    local = createContext({ path: world.db });
    sweeper = new HolderService(local.db, local.events, GRACE_MIN);
  });

  afterAll(async () => {
    await t?.kill();
    local?.close();
    await world?.stop();
  });

  const sessionHolders = () =>
    local.db.queryAll<{ id: string; ended_at: string | null }>(
      `SELECT id, ended_at FROM holders WHERE id LIKE 'claude:%' ORDER BY rowid`,
    );

  it(
    'keeps its claims under the new session id, and the sweep past the grace leaves them alone',
    async () => {
      const task = local.tasks.create({ title: 'E2E claim across /clear' }, 'e2e');
      t = new ClaudeTerm(
        world,
        120,
        40,
        {},
        ['--model', MODEL, '--allowedTools', 'mcp__plugin_agent-tasks_agent-tasks'],
        true,
      );
      await t.start(/agent-tasks: /);
      await waitUntil(() => sessionHolders().length === 1, 60_000, t);
      const before = sessionHolders()[0]!.id;

      await t.type(
        `Call the agent-tasks task_stage tool once with {"action":"claim","task_id":${task.id},"claimer":"e2e-clear"} (task_id as a number), then reply done.`,
      );
      await t.key('ENTER');
      await waitUntil(() => local.tasks.getById(task.id)!.holder === before, 120_000, t);

      await t.type('/clear');
      await t.key('ENTER');
      // The new session holds the task; the conversation before the /clear has ended.
      await waitUntil(
        () => {
          const h = local.tasks.getById(task.id)!.holder;
          return h !== null && h !== before && h.startsWith('claude:');
        },
        60_000,
        t,
      );
      const after = local.tasks.getById(task.id)!.holder!;
      const ended = Object.fromEntries(sessionHolders().map((h) => [h.id, h.ended_at !== null]));
      expect(ended).toEqual({ [before]: true, [after]: false });

      // Past the grace the old holder is gone, and it holds nothing: the sweep fails nothing.
      await sleep(minutes(GRACE_MIN) + 5_000);
      expect(sweeper.sweep()).toEqual([]);
      expect(local.tasks.getById(task.id)).toMatchObject({
        status: 'in_progress',
        assigned_to: 'e2e-clear',
        holder: after,
      });
    },
    minutes(5),
  );
});
