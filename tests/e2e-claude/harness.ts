// =============================================================================
// Harness for driving the /pipeline pane inside the real Claude Code CLI.
//
// A scratch world: its own SQLite file and port, seeded through the domain
// (dependencies, artifacts and history have no REST writer) before the REST
// server (`node dist/server.js --port --db`) starts on it. Claude Code runs in
// a pseudo-terminal (node-pty) and is rendered by @xterm/headless; the screen
// text is what the tests assert on. Nothing touches the user's REST server
// (127.0.0.1:3422) or database (~/.agent-tasks).
//
// Isolation from the installed plugin: `--setting-sources project,local` skips
// the user settings file, so its `enabledPlugins`, hooks, status line and `env`
// do not load; auth still comes from the normal credentials store. The plugin
// under test is a scratch copy of plugin/ whose .mcp.json runs this checkout's
// dist/index.js on the scratch database, on a port of its own: the pane talks
// to the world's server alone, so stopping it is seen as down.
// =============================================================================

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DIST = join(ROOT, 'dist');
export const SHOTS_DIR =
  process.env.AGENT_TASKS_E2E_SHOTS ??
  join(
    process.env.USERPROFILE ?? process.env.HOME ?? tmpdir(),
    '.claude',
    'tmp',
    'pane-shots-tasks',
    'e2e',
  );
/** Stable, so the folder-trust answer is remembered instead of piling up per run. */
const WORKSPACE = join(tmpdir(), 'agent-tasks-e2e-claude-ws');
/** Nothing listens here: the bridges to agent-comm and agent-knowledge fail open. */
const NOWHERE = 'http://127.0.0.1:9';
/** Who the pane acts as. */
export const ME = 'e2e-person';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
      .once('error', rej)
      .listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number };
        s.close(() => res(port));
      });
  });
}

/** Kills a process with its children; a plain kill on Windows orphans them. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/** The seeded tasks, by what the tests call them. */
export type Ids = Record<
  | 'pane'
  | 'boardView'
  | 'detailView'
  | 'harness'
  | 'review'
  | 'ship'
  | 'flaky'
  | 'badges'
  | 'screenshots'
  | 'bump'
  | 'duplicate'
  | 'changelog'
  | 'serverJson'
  | 'wsTests'
  | 'restyle'
  | 'darkMode',
  number
>;

export interface Task {
  id: number;
  title: string;
  stage: string;
  status: string;
  project: string | null;
  assigned_to: string | null;
  result: string | null;
  priority: number;
  tags: string | null;
  description: string | null;
}

export interface World {
  dir: string;
  port: number;
  base: string;
  env: Record<string, string>;
  pluginDir: string;
  ids: Ids;
  api: <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => Promise<T>;
  task(id: number): Promise<Task>;
  /** Stops the REST server alone (the down view). */
  stopServer(): Promise<void>;
  /** Starts it again on the same port and database. */
  startServer(): Promise<void>;
  stop(): Promise<void>;
}

async function health(base: string): Promise<boolean> {
  try {
    return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) })).ok;
  } catch {
    return false;
  }
}

/** The domain surface the seed uses (dist/context.js, loaded at run time). */
type Ctx = {
  tasks: {
    create(input: Record<string, unknown>, by: string): { id: number };
    claim(id: number, by: string): unknown;
    advance(id: number): unknown;
    complete(id: number, result: string): unknown;
    fail(id: number, error: string): unknown;
    cancel(id: number, reason: string): unknown;
    addDependency(id: number, dependsOn: number, relationship?: string): unknown;
    addArtifact(id: number, name: string, content: string, by: string): unknown;
  };
  comments: { add(id: number, by: string, content: string): unknown };
  close(): void;
};

const PANE_DESCRIPTION = [
  'Drop the web dashboard (UI files, WebSocket, agent-desk plugin) and move the board into a Claude Code mod.',
  '',
  'Acceptance:',
  '- /pipeline opens the board docked beside the conversation',
  '- every lifecycle action is reachable from the keyboard',
  '- the focus ring lands on the next step after every move',
  '- the status line shows what is in flight',
  '- toasts for tasks that finish or reach review',
  '- REST stays on 3422 for the pane',
  '- docs and the tutorial show the pane',
  '- e2e drives the real CLI',
  '- no regressions in the MCP tools',
  '- the pane polls only while it is open',
  '- version 2.0.0',
].join('\n');

/**
 * A board a person would recognise: the pane work in flight with a spec, comments and
 * subtasks, a blocked task, one in review, an unclaimed backlog across projects, recently
 * finished history, and one task per lifecycle flow the suite drives.
 */
async function seed(db: string): Promise<Ids> {
  const prev = { ...process.env };
  process.env.AGENT_COMM_URL = NOWHERE;
  process.env.AGENT_KNOWLEDGE_URL = NOWHERE;
  const { createContext } = (await import(pathToFileURL(join(DIST, 'context.js')).href)) as {
    createContext(o: { path: string }): Ctx;
  };
  const c = createContext({ path: db });
  const t = c.tasks;
  const mk = (title: string, o: Record<string, unknown> = {}, by = 'lead') =>
    t.create({ title, ...o }, by).id;
  try {
    const pane = mk('Replace the web dashboard with a Claude Code pane', {
      project: 'agent-tasks',
      priority: 8,
      tags: ['ui', 'plugin'],
      description: PANE_DESCRIPTION,
    });
    t.claim(pane, 'agent-pane');
    t.addArtifact(
      pane,
      'spec',
      '# Spec\n\n- Board by stage\n- Detail with actions\n- **New task** form\n\n```ts\nconst stages = 7;\n```',
      'agent-pane',
    );
    c.comments.add(pane, 'lead', 'Make sure it works docked at 60 columns.');
    c.comments.add(pane, 'agent-pane', 'Will do; screenshots at 60 and 160.');
    t.advance(pane);
    t.advance(pane);
    const boardView = mk('Pane: board view', { parent_id: pane });
    const detailView = mk('Pane: detail view', { parent_id: pane });
    t.claim(boardView, 'agent-board');
    t.complete(boardView, 'Board drawn by stage');
    const harness = mk('Write the e2e harness for the real CLI', {
      project: 'agent-tasks',
      priority: 5,
    });
    t.claim(harness, 'agent-e2e');
    t.addDependency(harness, pane);
    const review = mk('Review the REST changes', { project: 'agent-tasks', priority: 3 });
    t.claim(review, 'reviewer-1');
    for (let i = 0; i < 4; i++) t.advance(review);
    const ship = mk('Ship muk_import 19.0 to the customer', {
      project: 'odoo-addons',
      priority: 2,
      tags: ['release'],
    });
    const flaky = mk('Investigate flaky knowledge sync on Windows', {
      project: 'agent-knowledge',
    });
    const badges = mk('Tidy the README badges');
    const screenshots = mk('Migrate the old dashboard screenshots', { project: 'agent-tasks' });
    t.claim(screenshots, 'agent-docs');
    t.fail(screenshots, 'The screenshots are gone with the dashboard: nothing left to migrate.');
    const bump = mk('Bump agent-common to 1.1.2', { project: 'agent-tasks' });
    t.claim(bump, 'agent-release');
    t.complete(bump, 'Bumped; loopback bind and request guard in.');
    const duplicate = mk('Duplicate of the dashboard task', { project: 'agent-tasks' });
    t.cancel(duplicate, `duplicate of #${pane}`);
    t.addDependency(duplicate, pane, 'duplicate');

    // One task per flow the suite drives, so no test depends on another's leftovers.
    const changelog = mk('Write the CHANGELOG 2.0.0 entry', { project: 'release', priority: 4 });
    t.claim(changelog, 'agent-docs');
    const serverJson = mk('Bump server.json to 2.0.0', { project: 'release', priority: 4 });
    t.claim(serverJson, 'agent-release');
    for (let i = 0; i < 4; i++) t.advance(serverJson);
    const wsTests = mk('Port the WebSocket tests', { project: 'release' });
    t.claim(wsTests, 'agent-ws');
    t.advance(wsTests);
    t.advance(wsTests);
    const restyle = mk('Restyle the kanban columns', { project: 'release' });
    const darkMode = mk('Dark-mode toggle for the dashboard', { project: 'release' });

    return {
      pane,
      boardView,
      detailView,
      harness,
      review,
      ship,
      flaky,
      badges,
      screenshots,
      bump,
      duplicate,
      changelog,
      serverJson,
      wsTests,
      restyle,
      darkMode,
    };
  } finally {
    c.close();
    process.env = prev;
  }
}

/** Scratch database + REST server, seeded; the plugin copy pointed at them. */
export async function startWorld(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-tasks-e2e-claude-'));
  const db = join(dir, 'tasks.db');
  const [port, mcpPort] = [await freePort(), await freePort()];
  const base = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AGENT_TASKS_PORT: String(port),
    AGENT_TASKS_USER: ME,
    AGENT_COMM_URL: NOWHERE,
    AGENT_KNOWLEDGE_URL: NOWHERE,
  };
  // A Claude Code session running this suite must not leak its session markers into the child.
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_)/.test(k)) delete env[k];

  const ids = await seed(db);

  let server: ChildProcess | null = null;
  const startServer = async () => {
    let out = '';
    const child = spawn(
      process.execPath,
      [join(DIST, 'server.js'), '--port', String(port), '--db', db],
      { env, windowsHide: true },
    );
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    server = child;
    const deadline = Date.now() + 20_000;
    while (!(await health(base))) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server: ${out}`);
      await sleep(100);
    }
  };
  const stopServer = async () => {
    const child = server;
    server = null;
    if (!child) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    killTree(child.pid);
    await Promise.race([exited, sleep(5_000)]);
    const deadline = Date.now() + 5_000;
    while ((await health(base)) && Date.now() < deadline) await sleep(100);
  };
  await startServer();

  const api: World['api'] = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as never;
  };

  // The plugin under test, pointed at this checkout and this world.
  const pluginDir = join(dir, 'plugin');
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
            AGENT_TASKS_PORT: String(mcpPort),
            AGENT_COMM_URL: NOWHERE,
            AGENT_KNOWLEDGE_URL: NOWHERE,
          },
        },
      },
    }),
  );

  return {
    dir,
    port,
    base,
    env,
    pluginDir,
    ids,
    api,
    task: (id) => api<Task>('GET', `/api/tasks/${id}`),
    stopServer,
    startServer,
    async stop() {
      await stopServer();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        // Windows: the session's MCP child can briefly pin the database.
      }
    },
  };
}

const KEYS: Record<string, string> = {
  TAB: '\t',
  SHIFTTAB: '\x1b[Z',
  ENTER: '\r',
  DOWN: '\x1b[B',
  UP: '\x1b[A',
  ESC: '\x1b',
  BS: '\x7f',
  FOCUS: '\x18\t',
};

/** A focused Input draws its submit hint after the field. */
const SUBMIT_HINT = /[⏎↵]/;

/** Claude Code in a pseudo-terminal of `cols` x `rows`. */
export class ClaudeTerm {
  private readonly term: InstanceType<typeof xterm.Terminal>;
  private readonly serializer = new SerializeAddon();
  private proc: pty.IPty | null = null;

  /** `env` adds to the world's, e.g. CLAUDE_CODE_NO_FLICKER=1 for the fullscreen layout. */
  constructor(
    private readonly world: World,
    readonly cols = 120,
    readonly rows = 50,
    private readonly env: Record<string, string> = {},
  ) {
    this.term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
    this.term.loadAddon(this.serializer as never);
  }

  async start(): Promise<void> {
    mkdirSync(WORKSPACE, { recursive: true });
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    this.proc = pty.spawn(
      exe,
      [
        '--plugin-dir',
        this.world.pluginDir,
        '--setting-sources',
        'project,local',
        // The user's own MCP servers (~/.claude.json) stay out; the plugin's still load.
        '--strict-mcp-config',
      ],
      {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: WORKSPACE,
        env: { ...this.world.env, ...this.env },
      },
    );
    this.proc.onData((d) => this.term.write(d));
    // The plugin's status entry: its session.start ran, so /pipeline is registered.
    const ready = /agent-tasks: .*\d+ (in progress|open|pending)/;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const s = this.text();
      if (/Yes, I trust this folder/.test(s)) {
        // The default answer is "No, exit"; keys sent before the dialog settles are lost.
        await sleep(1_500);
        this.proc.write(KEYS.DOWN);
        await sleep(300);
        this.proc.write(KEYS.ENTER);
        await sleep(1_000);
      } else if (ready.test(s)) break;
      await sleep(300);
    }
    if (!ready.test(this.text())) throw new Error(`Claude Code never got ready:\n${this.screen()}`);
    await sleep(1_000);
  }

  /** The visible screen; inverted cells (the focus ring) are wrapped in «…». */
  screen(): string {
    const b = this.term.buffer.active;
    const cell = b.getNullCell();
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      const line = b.getLine(b.viewportY + y);
      if (!line) continue;
      let text = '';
      let inverted = false;
      for (let x = 0; x < this.cols; x++) {
        line.getCell(x, cell);
        const inv = cell.isInverse() !== 0;
        if (inv !== inverted) {
          text += inv ? '«' : '»';
          inverted = inv;
        }
        text += cell.getChars() || ' ';
      }
      if (inverted) text += '»';
      out.push(text.trimEnd());
    }
    return out.join('\n');
  }

  /** The screen without the focus marks, for assertions. */
  text(): string {
    return this.screen().replace(/[«»]/g, '');
  }

  async waitFor(re: RegExp, ms = 20_000): Promise<string> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const s = this.text();
      if (re.test(s)) return s;
      await sleep(250);
    }
    throw new Error(`screen never matched ${re}:\n${this.screen()}`);
  }

  async key(name: keyof typeof KEYS | string, times = 1): Promise<void> {
    for (let i = 0; i < times; i++) {
      this.proc!.write(KEYS[name] ?? name);
      await sleep(250);
    }
  }

  async type(text: string): Promise<void> {
    this.proc!.write(text);
    await sleep(400);
  }

  /**
   * What holds the focus: a Button is drawn inverted; a focused Input shows its submit hint
   * after the field, so its whole line stands for it.
   */
  focused(): string | null {
    const s = this.screen();
    const ring = /«([^»]*)»/.exec(s)?.[1]?.trim();
    if (ring) return ring;
    const input = s.split('\n').find((l) => SUBMIT_HINT.test(l));
    return input ? input.replace(/^[\s│]+|[\s│]+$/g, '') : null;
  }

  /**
   * Waits until the screen has held still for `quiet` ms (at most `ms`): after a move the pane
   * lands the ring itself a moment later, and a Tab sent before that is undone by it.
   */
  async settle(quiet = 600, ms = 4_000): Promise<void> {
    const deadline = Date.now() + ms;
    let last = this.screen();
    let since = Date.now();
    while (Date.now() < deadline && Date.now() - since < quiet) {
      await sleep(100);
      const now = this.screen();
      if (now !== last) [last, since] = [now, Date.now()];
    }
  }

  /**
   * Tab until the focus ring holds `label`. Each Tab waits for the ring to move, and a hit
   * must hold for a moment: a redraw (the plugin landing the ring itself) can move it.
   */
  async focus(label: string | RegExp, max = 60): Promise<void> {
    const hit = (f: string | null) =>
      f !== null && (typeof label === 'string' ? f.includes(label) : label.test(f));
    await this.settle();
    for (let i = 0; i < max; i++) {
      if (hit(this.focused())) {
        await sleep(300);
        if (hit(this.focused())) return;
        continue;
      }
      const before = this.focused();
      this.proc!.write(KEYS.TAB);
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline && this.focused() === before) await sleep(50);
    }
    throw new Error(`focus never reached ${label}:\n${this.screen()}`);
  }

  /**
   * Focus `label` and press Enter. Now and then the CLI drops an Enter that lands while the
   * pane redraws; when nothing on the screen moves for 4 s, it is pressed again.
   */
  async press(label: string | RegExp): Promise<void> {
    await this.focus(label);
    await this.enter();
  }

  /** Enter on what has the focus, pressed again if nothing on the screen moved (see press). */
  async enter(): Promise<void> {
    const before = this.screen();
    await this.key('ENTER');
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && this.screen() === before) await sleep(100);
    if (this.screen() === before) await this.key('ENTER');
  }

  /**
   * `/pipeline [args]` typed into the prompt (slash commands make no model call). Returns once
   * the command has answered: keys sent while it still runs are queued for the prompt.
   */
  async pipeline(args = ''): Promise<void> {
    const answered = () => {
      const lines = this.text().split('\n');
      const asked = lines.findLastIndex((l) => /^❯ \/pipeline/.test(l));
      return (
        asked >= 0 &&
        lines.slice(asked + 1).some((l) => /^\s+⎿/.test(l)) &&
        !/esc to interrupt/.test(lines.slice(-4).join('\n'))
      );
    };
    await this.type(`/pipeline${args ? ` ${args}` : ''}`);
    await sleep(300);
    await this.key('ENTER');
    const deadline = Date.now() + 20_000;
    while (!answered()) {
      if (Date.now() > deadline) throw new Error(`/pipeline never answered:\n${this.screen()}`);
      await sleep(100);
    }
    await sleep(300);
  }

  /** The whole screen as escape sequences: what a renderer replays. */
  serialize(): string {
    return this.serializer.serialize();
  }

  /** Writes <label>.ansi (for the PNG renderer) and returns the screen text. */
  shot(label: string): string {
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(
      join(SHOTS_DIR, `${label}.ansi`),
      JSON.stringify({ cols: this.cols, rows: this.rows, data: this.serialize() }),
    );
    return this.screen();
  }

  async kill(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      const exited = new Promise<void>((r) => proc.onExit(() => r()));
      killTree(proc.pid);
      await Promise.race([exited, sleep(5_000)]);
    }
    this.term.dispose();
  }
}
