import type { On } from 'claude-code';
import { expect, mock, test, type TestBody } from 'claude-code/testing';

import type { AgentTasksSnapshot, AgentTasksTask } from '../types';
import {
  ago,
  boardGroups,
  clip,
  cols,
  fitFacts,
  gateHint,
  isField,
  packParts,
  printable,
  time,
  when,
} from '../hooks/view';
import { isWorkPrompt } from '../hooks/work';

type Row = {
  id: number;
  title: string;
  description: string | null;
  stage: string;
  status: string;
  priority: number;
  project: string | null;
  assigned_to: string | null;
  tags: string | null;
  result: string | null;
  parent_id: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** What the server's task_get says the stage gate still needs. */
  gate_needs?: unknown;
};

const STAGES = ['backlog', 'spec', 'plan', 'implement', 'test', 'review', 'done'];

const task = (id: number, title: string, over: Partial<Row> = {}): Row => ({
  id,
  title,
  description: null,
  stage: 'backlog',
  status: 'pending',
  priority: 0,
  project: 'agent-tasks',
  assigned_to: null,
  tags: null,
  result: null,
  parent_id: null,
  created_by: 'system',
  created_at: '2026-10-09 20:00:00',
  updated_at: '2026-10-09 20:00:00',
  ...over,
});

type World = {
  tasks: Row[];
  deps?: { task_id: number; depends_on: number; relationship: string }[];
  comments?: {
    id: number;
    task_id: number;
    agent_id: string;
    content: string;
    created_at: string;
  }[];
  artifacts?: {
    id: number;
    task_id: number;
    stage: string;
    name: string;
    content: string;
    version: number;
    created_by: string;
    created_at: string;
  }[];
  isDown?: boolean;
  /** An agent-tasks from before the board holds the port: its version. */
  old?: string;
  /** The open task ids each claim holder holds. */
  held?: Record<string, number[]>;
  /** /api/holders never answers. */
  isHoldHung?: boolean;
  /** No request ever answers. */
  isHung?: boolean;
  /** The session's id (a /clear moves it on); 'sess-1' when unset. */
  sid?: string;
};

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };

const isOpenRow = (t: Row) => t.status === 'pending' || t.status === 'in_progress';

/** The agent-tasks REST server beneath the plugin, answering from `world`; mutations are recorded. */
function server(on: On, world: World) {
  const calls: Call[] = [];
  const toasts: string[] = [];
  /** Set, the next board poll answers what the board was when asked, once this resolves. */
  const held: { board: Promise<void> | null } = { board: null };
  const status: (string | undefined)[] = [];
  const opens: Record<string, unknown>[] = [];
  const placed = { value: { isPlaced: true } as { isPlaced: boolean; reason?: string } };
  /** What reached /api/holders: `POST claude:s {adopt}` or `DELETE claude:s`. */
  const holds: string[] = [];
  const clock = mock.clock(on);
  lastClock = clock;
  mock.env(on, { AGENT_TASKS_USER: 'mathi' });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url);
    const method = e.init?.method ?? 'GET';
    const sent = e.init?.body;
    const body =
      typeof sent === 'string' && sent ? (JSON.parse(sent) as Record<string, unknown>) : undefined;
    const p = url.pathname;
    const holder = /^\/api\/holders\/([^/]+)$/.exec(p);
    if (method !== 'GET' && !holder) calls.push({ method, path: p, body });
    const reply = (data: unknown, code = 200) => ({
      value: { status: code, ok: code < 400, headers: {}, text: JSON.stringify(data) },
    });
    if (world.isDown) return reply({ error: 'connection refused' }, 502);
    if (world.isHung || (holder && world.isHoldHung)) return new Promise<never>(() => {});
    if (holder && !world.old) {
      const name = decodeURIComponent(holder[1]!);
      const adopt = (body?.adopt as number[] | undefined) ?? [];
      holds.push(`${method} ${name}${adopt.length ? ` ${JSON.stringify(adopt)}` : ''}`);
      if (method === 'DELETE') return reply({ ok: true });
      const held = (world.held ??= {});
      held[name] = [...new Set([...(held[name] ?? []), ...adopt])];
      return reply({
        adopted: adopt,
        held: world.tasks.filter((t) => isOpenRow(t) && held[name]!.includes(t.id)),
      });
    }
    if (world.old)
      return p === '/health'
        ? reply({ status: 'ok', version: world.old })
        : reply({ error: 'Not found' }, 404);
    const m = /^\/api\/tasks\/(\d+)(\/\w+)?$/.exec(p);
    const one = m ? world.tasks.find((t) => t.id === Number(m[1])) : undefined;
    if (p === '/api/board') {
      const board = reply({
        stages: STAGES,
        pipelines: {},
        open: world.tasks.filter(isOpenRow),
        recent: world.tasks
          .filter((t) => !isOpenRow(t))
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
        dependencies: world.deps ?? [],
        subtaskProgress: {},
      });
      const wait = held.board;
      held.board = null;
      return wait ? wait.then(() => board) : board;
    }
    if (p === '/api/pipeline') return reply({ stages: STAGES, gate_config: null });
    if (p === '/api/tasks' && method === 'POST') {
      const t = task(100, String(body?.title), {
        project: (body?.project as string) ?? null,
        priority: Number(body?.priority ?? 0),
        created_by: String(body?.created_by),
      });
      world.tasks.push(t);
      return reply(t, 201);
    }
    if (m && !one) return reply({ error: 'Task not found' }, 404);
    if (one && !m?.[2] && method === 'GET') {
      const all = world.deps ?? [];
      const deps = all.filter((d) => d.relationship === 'blocks');
      const byId = (id: number) => world.tasks.find((t) => t.id === id)!;
      const comments = (world.comments ?? []).filter((c) => c.task_id === one.id);
      return reply({
        ...one,
        comments_count: comments.length,
        dependencies: {
          blockers: deps.filter((d) => d.task_id === one.id).map((d) => byId(d.depends_on)),
          blocking: deps.filter((d) => d.depends_on === one.id).map((d) => byId(d.task_id)),
          links: all
            .filter((d) => d.relationship !== 'blocks')
            .filter((d) => d.task_id === one.id || d.depends_on === one.id)
            .map((d) => ({
              task: byId(d.task_id === one.id ? d.depends_on : d.task_id),
              relationship: d.relationship,
              direction: d.task_id === one.id ? 'outgoing' : 'incoming',
            })),
        },
        subtasks: world.tasks.filter((t) => t.parent_id === one.id),
        subtree: {
          open: world.tasks.filter((t) => t.parent_id === one.id && isOpenRow(t)).map((t) => t.id),
          finished: world.tasks.filter((t) => t.parent_id === one.id && !isOpenRow(t)).length,
        },
        artifacts: (world.artifacts ?? []).filter((a) => a.task_id === one.id),
        comments,
      });
    }
    if (one && !m?.[2] && method === 'DELETE') {
      world.tasks = world.tasks.filter((t) => t !== one);
      return reply({ ok: true });
    }
    if (one && m?.[2] === '/comments') {
      world.comments = [
        ...(world.comments ?? []),
        {
          id: 50,
          task_id: one.id,
          agent_id: String(body?.agent_id),
          content: String(body?.content),
          created_at: '2026-10-09 21:00:00',
        },
      ];
      return reply({ id: 50 }, 201);
    }
    if (one && m?.[2] === '/stage') {
      const a = body?.action;
      const at = STAGES.indexOf(one.stage);
      if ((a === 'advance' || a === 'complete') && one.gate_needs)
        return reply(
          {
            error: `Stage gate: at least one comment required before advancing from '${one.stage}'.`,
          },
          422,
        );
      if (a === 'advance') {
        if (body?.from && body.from !== one.stage)
          return reply(
            { error: `Task ${one.id} moved to ${one.stage} meanwhile, not ${String(body.from)}.` },
            409,
          );
        if ((world.deps ?? []).some((d) => d.task_id === one.id))
          return reply({ error: 'Blocked by incomplete dependencies: #2' }, 409);
        const to = body?.stage ? STAGES.indexOf(String(body.stage)) : at + 1;
        if (to <= at) return reply({ error: `Target stage '${body?.stage}' is not ahead` }, 422);
        Object.assign(one, { stage: STAGES[to], status: 'in_progress' });
      } else if (a === 'regress')
        Object.assign(one, {
          stage: body?.stage,
          ...(body?.stage === 'backlog' ? { status: 'pending', assigned_to: null } : {}),
        });
      else if (a === 'complete')
        Object.assign(one, { status: 'completed', stage: 'done', result: body?.result });
      else if (a === 'fail') Object.assign(one, { status: 'failed', result: body?.result });
      else if (a === 'cancel')
        Object.assign(one, { status: 'cancelled', stage: 'cancelled', result: body?.reason });
      else if (a === 'reopen')
        Object.assign(one, { status: 'pending', stage: 'review', assigned_to: null, result: null });
      one.updated_at = '2026-10-09 22:00:00';
      return reply(one);
    }

    return reply({ error: 'Not found' }, 404);
  });
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  on('session.id', () => ({ value: world.sid ?? 'sess-1' }) as never);
  on('ui.status', (_$, e) => (status.push(e.text), { value: undefined }));
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }));
  on('ui.log', () => ({ value: undefined }));
  on('ui.open', (_$, e) => (opens.push({ ...e }), { value: placed.value }) as never);
  const panes = { value: [] as { id: string; isPlaced: boolean }[] };
  on('ui.panes', () => ({ value: panes.value }) as never);
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}));
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }));

  return { calls, toasts, held, status, opens, placed, panes, clock, holds };
}

const RUN = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 134 },
} as const;
const pane = (placement: 'dock' | 'inline', bodyColumns = 58) =>
  ({
    title: 'agent-tasks',
    isFocused: true,
    bodyColumns,
    placement,
    scroll: { bodyRows: 30 },
    view: {},
  }) as never;
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const;

const BOARD = (): Row[] => [
  task(1, 'Write the spec', {
    stage: 'spec',
    status: 'in_progress',
    assigned_to: 'agent-a',
    priority: 5,
  }),
  task(2, 'Ship the pane', { stage: 'implement', status: 'in_progress', assigned_to: 'agent-b' }),
  task(3, 'Docs pass', { project: 'docs', tags: '["release"]' }),
  task(4, 'Old work', {
    status: 'completed',
    stage: 'done',
    result: 'merged',
    updated_at: '2026-10-09 21:00:00',
  }),
];

type Engine = Parameters<TestBody>[0];
type Surface = (typeof SURFACES)[number];

/** The clock of the test's server: a person's press comes after the view they press in drew. */
let lastClock: ReturnType<typeof mock.clock> | null = null;

/** A press the pane takes when it comes this soon after the controls changed (C1). */
const GUARD_MS = 400;
const isGuardedKey = (key: string) =>
  /^(advance:.+|complete:.+|ask:.+|ask-delete|reopen|confirm-yes|form-submit|create)$/.test(key);

/**
 * The pane, mounted. Its `press` is a person's: a press on a control that changes a task comes
 * once the view it is in has drawn (the guard takes one that comes sooner; `hurried` presses
 * at once, as a second Enter does).
 */
async function mount<S extends Surface = 'terminal'>(
  $: Engine,
  surface: S = 'terminal' as S,
  columns = 58,
) {
  const ui = await $.ui.mount({
    plugin: 'agent-tasks',
    surface,
    component: 'Pane',
    props: pane('dock', columns),
    requestId: 'agent-tasks',
  });
  const hurried = ui.press.bind(ui);
  const press: typeof ui.press = async (q) => {
    const key = (q as { key?: string }).key ?? '';
    if (isGuardedKey(key)) await lastClock?.advance(GUARD_MS + 1);
    return hurried(q);
  };
  // The mounted pane is frozen: its methods are read through, press and hurried added.
  return new Proxy({} as typeof ui & { hurried: typeof ui.press }, {
    get: (_, k) => {
      if (k === 'press') return press;
      if (k === 'hurried') return hurried;
      const v = Reflect.get(ui, k, ui) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(ui) : v;
    },
  });
}

test('/pipeline opens a plain sidebar pane with the board on every surface', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const out = await $.command.run({ command: 'pipeline', args: '', ...RUN });
  // The open pane says it all: nothing goes into the transcript (nor to the model).
  expect(out.text).toBeUndefined();
  expect(s.status.at(-1)).toBe('3 open tasks · 2 in progress');
  expect(s.opens).toEqual([expect.objectContaining({ id: 'agent-tasks', focus: true })]);
  expect(s.opens[0]).not.toHaveProperty('closeOnEscape');
  for (const surface of SURFACES) {
    const ui = await mount($, surface);
    await expect(ui.drawn()).resolves.toMatchObject({ type: 'Box' });
    expect(await ui.find({ key: 'open:1' })).toBeDefined();
    expect(await ui.find({ key: 'open:4' })).toBeUndefined(); // finished: under Done
    expect(await ui.find({ type: 'Text', text: /^Spec$/ })).toBeDefined();
    await ui.unmount();
  }
  // A task opened by its number: the pane shows it, the transcript (and the model) get nothing.
  expect((await $.command.run({ command: 'pipeline', args: '2', ...RUN })).text).toBeUndefined();
  // Only what went wrong is said there.
  expect((await $.command.run({ command: 'pipeline', args: '99', ...RUN })).text).toBe(
    'there is no task #99',
  );
});

test('/pipeline says why when the pane is not placed', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  s.placed.value = { isPlaced: false, reason: 'below 110 columns' };
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const out = await $.command.run({ command: 'pipeline', args: '', ...RUN });
  // No pane to show the board: the summary goes with the reason.
  expect(out.text).toBe('3 open tasks · 2 in progress\npane not shown: below 110 columns');
});

test('Find narrows the board by id, title, agent, project or tag; a blocked task says what it waits for', async ($, on) => {
  server(on, { tasks: BOARD(), deps: [{ task_id: 2, depends_on: 1, relationship: 'blocks' }] });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const out = await $.command.run({ command: 'pipeline', args: 'docs', ...RUN });
  expect(out.text).toBeUndefined(); // the pane says "1 shown"
  const ui = await mount($);
  // The ring starts on the first row shown when the pane takes the keys.
  expect(await ui.find({ key: 'open:3' })).toMatchObject({ props: { autoFocus: true } });
  expect(await ui.find({ key: 'open:1' })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /1 shown/ })).toBeDefined();
  expect(await ui.find({ type: 'Select' })).toBeUndefined(); // no project select: Find has it
  expect(await ui.find({ key: 'find:1' })).toMatchObject({
    props: { value: 'docs', placeholder: 'id, title, agent, project or tag' },
  });
  await ui.input({ key: 'find:1', text: '' });
  expect(await ui.find({ key: 'clear-filter' })).toBeUndefined(); // nothing to clear
  expect(await ui.find({ type: 'Text', text: /waits for #1/ })).toBeDefined();
  // A find lands on the first row it shows (once that board is drawn: e2e checks the ring).
  await ui.input({ key: 'find:2', text: 'agent-b' });
  expect(await ui.find({ key: 'open:2' })).toMatchObject({ props: { autoFocus: true } });
  expect(await ui.find({ key: 'open:3' })).toBeUndefined();
  expect(await ui.find({ key: 'clear-filter' })).toBeDefined();
  // Found by a tag: the row says which, tags being nowhere else on it.
  await ui.input({ key: 'find:3', text: 'release' });
  expect(await ui.find({ key: 'open:3' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /tag release/ })).toBeDefined();
  await ui.input({ key: 'find:4', text: 'nothing like this' });
  expect(await ui.find({ type: 'Text', text: /No open task matches/ })).toBeDefined();
  expect(await ui.find({ key: 'clear-filter' })).toMatchObject({ props: { autoFocus: true } });
  await ui.press({ key: 'clear-filter' });
  expect(await ui.find({ key: 'open:2' })).toBeDefined();
  // The whole board back: the ring on the first task in progress, not on the queue.
  expect(await ui.find({ key: 'open:1' })).toMatchObject({ props: { autoFocus: true } });
  // A find that matches nothing is said in the transcript too.
  expect((await $.command.run({ command: 'pipeline', args: 'zzz', ...RUN })).text).toBe(
    'no open task matches "zzz"',
  );
});

test('/pipeline and /pipeline <id> drop the text the last /pipeline <text> found', async ($, on) => {
  server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: 'docs', ...RUN });
  await $.command.run({ command: 'pipeline', args: '1', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'back' });
  expect(await ui.find({ key: 'open:2' })).toBeDefined();
  expect(await ui.find({ key: 'clear-filter' })).toBeUndefined();
  await $.command.run({ command: 'pipeline', args: 'docs', ...RUN });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  expect(await ui.find({ key: 'open:2' })).toBeDefined();
});

test('advance and complete as the person, the next step offered first', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '#2', ...RUN });
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface);
    expect(await ui.find({ type: 'Text', text: /Ship the pane/ })).toBeDefined();
    await ui.unmount();
  }
  const ui = await mount($);
  await ui.press({ key: 'advance:test' });
  // The stage the button names: a second press of a stale Advance is refused, never a skip.
  expect(s.calls.at(-1)).toEqual({
    method: 'POST',
    path: '/api/tasks/2/stage',
    body: { action: 'advance', stage: 'test', from: 'implement', by: 'mathi' },
  });
  expect(await ui.find({ type: 'Text', text: /#2 moved to test/ })).toBeDefined();
  await ui.press({ key: 'advance:review' });
  expect(await ui.find({ key: 'advance:done' })).toBeUndefined(); // review: the next step is done
  await ui.press({ key: 'complete:review' });
  await ui.input({ key: 'form:complete', text: '  ' });
  expect(await ui.find({ type: 'Text', text: /a result is needed/ })).toBeDefined();
  await ui.input({ key: 'form:complete', text: 'pane merged' });
  expect(s.calls.at(-1)).toMatchObject({ body: { action: 'complete', result: 'pane merged' } });
  expect(await ui.find({ type: 'Text', text: /completed/ })).toBeDefined();
  expect(s.toasts).toEqual([]); // the pane's own acts are not toasted
});

test('an unclaimed task is left for the agents to claim', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '3', ...RUN });
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /Docs pass/ })).toBeDefined();
  expect(await ui.find({ key: 'claim' })).toBeUndefined();
  expect(await ui.find({ key: 'advance:spec' })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /once an agent claims it/ })).toBeDefined();
  expect(await ui.find({ key: 'ask:cancel' })).toBeDefined();
  expect(s.calls).toEqual([]);
});

test('an assigned task that has not started says who it waits for', async ($, on) => {
  const tasks = BOARD();
  tasks[2] = { ...tasks[2]!, assigned_to: 'agent-c' };
  server(on, { tasks });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '3', ...RUN });
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: 'Waiting for agent-c to start it.' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /Unclaimed/ })).toBeUndefined();
});

test("an action form's button submits what was typed, as Enter does", async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'ask:fail' });
  await ui.press({ key: 'form-submit' });
  expect(await ui.find({ type: 'Text', text: /what went wrong is needed/ })).toBeDefined();
  await ui.input({ key: 'form:fail', text: 'flaky CI', kind: 'change' });
  await ui.press({ key: 'form-submit' });
  expect(s.calls.at(-1)).toMatchObject({ body: { action: 'fail', result: 'flaky CI' } });
});

test('summary parts break between parts, no line ending or starting on the separator', () => {
  expect(packParts(['8 open tasks', '2 in progress', '1 blocked'], 30)).toEqual([
    ['8 open tasks', '2 in progress'],
    ['1 blocked'],
  ]);
  expect(packParts(['a', 'b'], 5)).toEqual([['a', 'b']]);
  expect(packParts(['a', 'b'], 4)).toEqual([['a'], ['b']]);
  expect(packParts(['設計', '実装'], 9)).toEqual([['設計'], ['実装']]);
});

test('a long backlog folds past five rows; a find or a stage at work never does', () => {
  const t = (id: number, stage: string, status: 'pending' | 'in_progress'): AgentTasksTask => ({
    id,
    title: `Task ${id}`,
    stage,
    status,
    priority: 0,
    project: null,
    assigned_to: null,
    tags: [],
    parent_id: null,
    result: null,
    updated_at: '2026-10-09 20:00:00',
    blocked_by: [],
    subtasks: null,
  });
  const snap: AgentTasksSnapshot = {
    isUp: true,
    origin: '',
    old: null,
    stages: STAGES,
    pipelines: {},
    open: [
      ...Array.from({ length: 30 }, (_, i) => t(i + 1, 'backlog', 'pending')),
      ...Array.from({ length: 13 }, (_, i) => t(i + 100, 'implement', 'in_progress')),
    ],
    recent: [],
    me: 'mathi',
  };
  const [backlog, implement] = boardGroups(snap, '', []);
  expect(backlog).toMatchObject({ stage: 'backlog', hidden: 25 });
  expect(backlog!.tasks).toHaveLength(5);
  expect(implement).toMatchObject({ stage: 'implement', hidden: 0 });
  expect(implement!.tasks).toHaveLength(13);
  expect(boardGroups(snap, '', ['stage:backlog'])[0]).toMatchObject({ hidden: 0 });
  expect(boardGroups(snap, 'Task', [])[0]).toMatchObject({ hidden: 0 });
});

test('a gate says what it needs and who gives it', () => {
  const g = { comment: false, artifact: false, artifacts: [], more: 0, approval: false };
  expect(gateHint({ ...g, comment: true }, 'spec')).toBe(
    'Needs a comment before it leaves spec: add the comment below.',
  );
  expect(gateHint({ ...g, artifacts: ['design'] }, 'spec')).toBe(
    'Needs artifact design before it leaves spec: an agent attaches artifacts.',
  );
});

test('widths count terminal columns: wide characters two, marks none', () => {
  expect(cols('abc')).toBe(3);
  expect(cols('設計書')).toBe(6);
  expect(cols('ship 🚀')).toBe(7);
  expect(cols('é')).toBe(1);
  expect(clip('設計書のレビュー', 7)).toBe('設計書…');
  expect(cols(clip('設計書のレビュー', 7))).toBeLessThanOrEqual(7);
  expect(clip('short', 10)).toBe('short');
});

test('send back picks the stage; fail and cancel need their words; delete asks first', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($, 'terminal', 80);
  await ui.press({ key: 'ask:regress' });
  await ui.select({ key: 'form-stage', value: 'spec' });
  await ui.input({ key: 'form:regress', text: 'needs a spec' });
  expect(s.calls.at(-1)).toMatchObject({
    body: { action: 'regress', stage: 'spec', reason: 'needs a spec' },
  });
  await ui.press({ key: 'ask:fail' });
  await ui.press({ key: 'form-dismiss' });
  expect(await ui.find({ key: 'form:fail' })).toBeUndefined();
  expect(await ui.find({ key: 'ask:fail' })).toBeDefined();
  await ui.press({ key: 'ask:cancel' });
  await ui.input({ key: 'form:cancel', text: 'duplicate' });
  expect(s.calls.at(-1)).toMatchObject({ body: { action: 'cancel', reason: 'duplicate' } });
  // A dropped task is no success: its outcome wears the task's own mark, not a green ✓.
  const said = await ui.find({ type: 'Text', text: '– #2 cancelled' });
  expect(said).toBeDefined();
  expect(said?.props).not.toHaveProperty('color');
  await ui.press({ key: 'ask-delete' });
  await ui.press({ key: 'confirm-no' });
  expect(s.calls.some((c) => c.method === 'DELETE')).toBe(false);
  await ui.press({ key: 'ask-delete' });
  await ui.press({ key: 'confirm-yes' });
  expect(s.calls.at(-1)).toEqual({ method: 'DELETE', path: '/api/tasks/2', body: undefined });
  expect(await ui.find({ key: 'open:1' })).toBeDefined(); // back on the board
});

test('a blocked task offers no advance or complete and says what it waits for; blockers open from the detail', async ($, on) => {
  server(on, { tasks: BOARD(), deps: [{ task_id: 2, depends_on: 1, relationship: 'blocks' }] });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  expect(await ui.find({ key: 'advance:test' })).toBeUndefined();
  expect(await ui.find({ key: 'complete:implement' })).toBeUndefined();
  expect(await ui.find({ key: 'ask:fail' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /It moves on once #1 is done/ })).toBeDefined();
  await ui.press({ key: 'dep:1' });
  expect(await ui.find({ type: 'Text', text: /Write the spec/ })).toBeDefined();
  // The way back names the task it goes to, by its title.
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ Ship the pane' } });
  // #2 under Blocks is marked as the board marks it: blocked, not in progress.
  expect(await ui.find({ type: 'Text', text: /^!$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^●$/ })).toBeUndefined();
  await ui.press({ key: 'back' });
  expect(await ui.find({ type: 'Text', text: /Ship the pane/ })).toBeDefined();
});

test('comments are sent as the person; artifacts unfold', async ($, on) => {
  const s = server(on, {
    tasks: BOARD(),
    artifacts: [
      {
        id: 7,
        task_id: 1,
        stage: 'spec',
        name: 'spec',
        content: '# Spec\n- one',
        version: 2,
        created_by: 'agent-a',
        created_at: '2026-10-09 20:10:00',
      },
    ],
  });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '1', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'art:7:shut' });
  expect(await ui.find({ type: 'Markdown' })).toMatchObject({ props: { text: '# Spec\n- one' } });
  // The toggle's key names its state, so the ring lands on it once that state is drawn.
  expect(await ui.find({ key: 'art:7:open' })).toBeDefined();
  await ui.press({ key: 'art:7:open' });
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined();
  await ui.input({ key: 'comment:0', text: 'looks good' });
  expect(s.calls.at(-1)).toEqual({
    method: 'POST',
    path: '/api/tasks/1/comments',
    body: { content: 'looks good', agent_id: 'mathi' },
  });
  expect(await ui.find({ key: 'comment:1' })).toBeDefined(); // a fresh, empty field
  expect(await ui.find({ type: 'Text', text: 'looks good' })).toBeDefined();
});

test('new task: Tab walks the fields and Enter in any of them creates; nothing is drawn anew under the typing', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'tab:new' });
  await ui.input({ key: 'new-title:1', text: 'Try the pane', kind: 'change' });
  await ui.input({ key: 'new-project:1', text: 'agent-tasks', kind: 'change' });
  // Typed into, the fields keep their keys and their drawn value: a value fed back on each key
  // would replace what the person is typing, dropping keys typed fast.
  expect((await ui.find({ key: 'new-title:1' }))?.props.value).toBe('');
  expect(await ui.find({ key: 'new-description:1' })).toMatchObject({ props: { rows: 3 } });
  // Enter with a priority that is no number: said at its field, nothing created.
  await ui.input({ key: 'new-priority:1', text: 'high' });
  expect(s.calls).toEqual([]);
  expect(await ui.find({ type: 'Text', text: /a whole number, like 0 or 5/ })).toBeDefined();
  // Drawn anew, the fields hold what was typed.
  expect((await ui.find({ key: 'new-title:2' }))?.props.value).toBe('Try the pane');
  expect((await ui.find({ key: 'new-priority:2' }))?.props.value).toBe('high');
  // Enter in the title, the priority fixed: created with every field.
  await ui.input({ key: 'new-priority:2', text: '3', kind: 'change' });
  await ui.input({ key: 'new-title:2', text: 'Try the pane' });
  expect(s.calls.at(-1)).toEqual({
    method: 'POST',
    path: '/api/tasks',
    body: { title: 'Try the pane', priority: 3, created_by: 'mathi', project: 'agent-tasks' },
  });
  expect(await ui.find({ type: 'Text', text: 'Try the pane' })).toBeDefined(); // its detail
  await ui.press({ key: 'tab:new' });
  expect(await ui.find({ key: 'new-title:3' })).toMatchObject({ props: { value: '' } });
});

test('a toast says what finished or reached review since the last poll', async ($, on) => {
  const world: World = { tasks: BOARD() };
  const s = server(on, world);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await s.clock.advance(30_000);
  expect(s.toasts).toEqual([]);
  Object.assign(world.tasks[0]!, {
    status: 'completed',
    stage: 'done',
    updated_at: '2026-10-09 23:00:00',
  });
  Object.assign(world.tasks[1]!, { stage: 'review' });
  await s.clock.advance(30_000);
  // The news first: a toast cut short keeps it. The toast box carries the plugin's name.
  // The pane closed: it says where to look.
  expect(s.toasts).toEqual([
    'Done: #1 Write the spec · Ready for review: #2 Ship the pane (/pipeline)',
  ]);
  await s.clock.advance(30_000);
  expect(s.toasts).toHaveLength(1);
});

test('a toast names a task cut by display width, and with the pane shown says no more', async ($, on) => {
  const world: World = {
    tasks: [
      task(1, '日本語のドキュメントを翻訳して公開するための長いタスクの名前', {
        status: 'in_progress',
        stage: 'implement',
      }),
    ],
  };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-tasks', isPlaced: true, isFocused: false } as never];
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await s.clock.advance(5_000);
  Object.assign(world.tasks[0]!, { stage: 'review' });
  await s.clock.advance(5_000);
  expect(s.toasts).toHaveLength(1);
  const name = s.toasts[0]!.replace('Ready for review: #1 ', '');
  expect(cols(name)).toBeLessThanOrEqual(40);
  expect(name.endsWith('…')).toBe(true);
});

test('a row keeps whole facts: one that does not fit is left out, never cut', () => {
  const facts = ['agent-pane', 'part of #1', false as const, 'agent-tasks', '5m ago'];
  expect(fitFacts(facts, 40)).toEqual(['agent-pane', 'part of #1', 'agent-tasks']);
  expect(fitFacts(facts, 24)).toEqual(['agent-pane', 'part of #1']);
  expect(fitFacts(facts, 5)).toEqual([]);
});

test('a stage gate is said up front: what it needs before the task leaves its stage', async ($, on) => {
  const gate = {
    stage: 'implement',
    comment: true,
    artifact: false,
    artifacts: ['review-notes'],
    min_artifacts: 0,
    approval: false,
  };
  server(on, {
    tasks: BOARD().map((t) => (t.id === 2 ? { ...t, gate_needs: gate } : t)),
  });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  expect(
    await ui.find({
      type: 'Text',
      text: /Needs a comment and artifact review-notes before it leaves implement: add the comment below; an agent attaches artifacts\./,
    }),
  ).toBeDefined();
  // An artifact only an agent attaches: Advance and Complete cannot pass it from here, so
  // neither is offered. The ring lands on the way back, never in the comment field.
  expect(await ui.find({ key: 'advance:test' })).toBeUndefined();
  expect(await ui.find({ key: 'complete:implement' })).toBeUndefined();
  expect(await ui.find({ key: 'ask:fail' })).toBeDefined();
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { autoFocus: true } });
});

test('a comment-only gate keeps Advance: the comment is given here', async ($, on) => {
  const gate = {
    stage: 'implement',
    comment: true,
    artifact: false,
    artifacts: [],
    min_artifacts: 0,
    approval: false,
  };
  server(on, { tasks: BOARD().map((t) => (t.id === 2 ? { ...t, gate_needs: gate } : t)) });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  const advance = await ui.find({ key: 'advance:test' });
  expect(advance).toBeDefined();
  expect(advance?.props.variant).toBeUndefined(); // not the one to press while it holds
  expect(await ui.find({ key: 'complete:implement' })).toBeDefined();
});

test('an approval gate takes Advance and Complete away too', async ($, on) => {
  const gate = {
    stage: 'implement',
    comment: false,
    artifact: false,
    artifacts: [],
    min_artifacts: 0,
    approval: true,
  };
  server(on, { tasks: BOARD().map((t) => (t.id === 2 ? { ...t, gate_needs: gate } : t)) });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  expect(await ui.find({ key: 'advance:test' })).toBeUndefined();
  expect(await ui.find({ key: 'complete:implement' })).toBeUndefined();
  expect(
    await ui.find({ type: 'Text', text: /an approval cannot be given from here/ }),
  ).toBeDefined();
});

test('a refusal the gate hint explains says only that it held; Complete keeps its words', async ($, on) => {
  const gate = {
    stage: 'implement',
    comment: true,
    artifact: false,
    artifacts: [],
    min_artifacts: 0,
    approval: false,
  };
  const s = server(on, {
    tasks: BOARD().map((t) => (t.id === 2 ? { ...t, gate_needs: gate } : t)),
  });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'advance:test' });
  // It says where the comment goes; the ring stays on Advance, never in the comment field.
  expect(
    await ui.find({ type: 'Text', text: "✗ #2 can't leave implement yet: add the comment below" }),
  ).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /Stage gate:/ })).toBeUndefined();
  await ui.press({ key: 'complete:implement' });
  await ui.input({ key: 'form:complete', text: 'shipped', kind: 'change' });
  await ui.press({ key: 'form-submit' });
  expect(await ui.find({ type: 'Text', text: /✗ #2 can't leave implement yet/ })).toBeDefined();
  // The form stays with its words, and says under it what the gate holds for.
  expect(await ui.find({ key: 'form-submit' })).toBeDefined();
  // Drawn anew under its next key with the words sent (Enter cleared the field).
  expect((await ui.find({ key: 'form:complete:1' }))?.props.value).toBe('shipped');
  expect(
    await ui.find({ type: 'Text', text: /Needs a comment before it leaves implement/ }),
  ).toBeDefined();
  await ui.press({ key: 'form-submit' });
  expect(s.calls.at(-1)?.body).toMatchObject({ action: 'complete', result: 'shipped' });
});

test('the Done tab lists finished tasks with their result', async ($, on) => {
  server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'tab:done' });
  expect(await ui.find({ type: 'Text', text: /merged/ })).toBeDefined();
  await ui.press({ key: 'open:4' });
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ Done' } });
  expect(await ui.find({ key: 'complete:done' })).toBeUndefined();
});

test('a finished task opens again: Reopen sends it back unclaimed, the board shows it', async ($, on) => {
  const world: World = { tasks: BOARD() };
  const s = server(on, world);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '4', ...RUN });
  const ui = await mount($);
  expect(await ui.find({ key: 'ask:fail' })).toBeUndefined();
  await ui.press({ key: 'reopen' });
  expect(s.calls.at(-1)).toEqual({
    method: 'POST',
    path: '/api/tasks/4/stage',
    body: { action: 'reopen', by: 'mathi' },
  });
  expect(
    await ui.find({ type: 'Text', text: '✓ #4 open again in review, unclaimed' }),
  ).toBeDefined();
  expect(await ui.find({ key: 'reopen' })).toBeUndefined();
});

test('server down: what to do, offline in the status line, a Refresh that says it tried', async ($, on) => {
  const world: World = { tasks: BOARD(), isDown: true };
  const s = server(on, world);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const out = await $.command.run({ command: 'pipeline', args: '', ...RUN });
  expect(out.text).toContain('nothing answers at http://127.0.0.1:3422');
  expect(s.status.at(-1)).toBe('offline');
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /not reachable/ })).toBeDefined();
  expect(await ui.find({ key: 'retry' })).toMatchObject({ props: { autoFocus: true } });
  await ui.press({ key: 'retry' });
  expect(
    await ui.find({
      type: 'Text',
      text: /✗ still nothing answers at http:\/\/127\.0\.0\.1:3422 \(\d\d:\d\d:\d\d\)/,
    }),
  ).toBeDefined();
  // The tabs stay while it is down, so a digit stays in the pane.
  expect(await ui.find({ key: 'tab:done' })).toBeDefined();
  world.isDown = false;
  await ui.press({ key: 'retry' });
  expect(await ui.find({ key: 'open:1' })).toMatchObject({ props: { autoFocus: true } });
});

test('an agent-tasks from before the board on the port is named, not taken for nothing', async ($, on) => {
  const s = server(on, { tasks: BOARD(), old: '1.9.3' });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const out = await $.command.run({ command: 'pipeline', args: '', ...RUN });
  expect(out.text).toContain('version 1.9.3 holds http://127.0.0.1:3422');
  expect(s.status.at(-1)).toBe('old server 1.9.3 on the port');
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /An older agent-tasks \(1\.9\.3\)/ })).toBeDefined();
});

test("a poll that answers after the pane's own act was drawn neither undoes it nor toasts it", async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  s.panes.value = [{ id: 'agent-tasks', isPlaced: true }];
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  let release = () => {};
  s.held.board = new Promise<void>((r) => (release = r));
  const tick = s.clock.advance(5_000); // its poll is asked now and answers late
  await ui.press({ key: 'ask:fail' });
  await ui.input({ key: 'form:fail', text: 'gone' });
  release();
  await tick;
  await s.clock.advance(10_000);
  expect(s.toasts).toEqual([]);
  expect(s.status.at(-1)).toBe('2 open tasks · 1 in progress');
});

/** The plugin with its pipeline reminder on. */
const remind = { options: { enforcePipeline: true } } as const;

test('the model starts with what is in flight, the claims of this session first and marked', async ($, on) => {
  const s = server(on, { tasks: BOARD(), held: { 'claude:sess-1': [2] } });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await s.clock.advance(0);
  const r = await $.prompt.context({ blocks: [] });
  const block = r.blocks.find((b) => b.name === 'agent-tasks');
  expect(block?.text).toContain(
    '2 in progress: #2 "Ship the pane" [implement, agent-b, this session]; #1 "Write the spec" [spec, agent-a]',
  );
  expect(block?.text).toContain('1 pending, highest priority first: #3 "Docs pass" [backlog]');
  // The reminder off: it says how a task is claimed, and does not ask for it.
  expect(block?.text).toContain('A task is claimed with task_stage action "claim".');
  expect(block?.text).not.toContain('before working on it');
});

test('with the reminder on, the context asks to claim before working', remind, async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await s.clock.advance(0);
  const r = await $.prompt.context({ blocks: [] });
  expect(r.blocks.find((b) => b.name === 'agent-tasks')?.text).toContain(
    'Claim a task (task_stage action "claim") before working on it.',
  );
});

test('the tab shown takes its own key: the ring lands on the work in progress, nothing leaks', async ($, on) => {
  server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  expect(await ui.find({ key: 'tab:board' })).toMatchObject({
    type: 'Button',
    props: { hotkey: '1' },
  });
  // Pressed again it keeps the view; the ring starts on the first task in progress (#1, under
  // the backlog's #3), so the queue never buries the work (e2e checks the ring).
  await ui.press({ key: 'tab:board' });
  expect(await ui.find({ key: 'open:1' })).toMatchObject({ props: { autoFocus: true } });
  await ui.press({ key: 'tab:done' });
  await ui.press({ key: 'tab:done' });
  expect(await ui.find({ key: 'open:4' })).toMatchObject({ props: { autoFocus: true } });
});

test('the text fields are told apart from the buttons by their keys', () => {
  for (const key of ['find:2', 'new-title:1', 'new-description:3', 'comment:4', 'form:fail'])
    expect(isField(key)).toBe(true);
  for (const key of ['open:3', 'form-submit', 'form-dismiss', 'form-stage', 'tab:new', null])
    expect(isField(key)).toBe(false);
});

test('a task failed from the pane is said plainly, not as an error, and the outcome goes after a while', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'ask:fail' });
  await ui.input({ key: 'form:fail', text: 'gone' });
  const said = await ui.find({ type: 'Text', text: '– #2 marked failed' });
  expect(said).toBeDefined();
  expect(said!.props).not.toHaveProperty('color');
  await s.clock.advance(10_000);
  expect(await ui.find({ type: 'Text', text: /#2 marked failed/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /Esc to the prompt/ })).toBeDefined();
});

test('an outcome goes at the next navigation', async ($, on) => {
  server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'advance:test' });
  expect(await ui.find({ type: 'Text', text: /moved to test/ })).toBeDefined();
  await ui.press({ key: 'back' });
  expect(await ui.find({ type: 'Text', text: /moved to test/ })).toBeUndefined();
});

test('an older server taking the port while a task is open shows that, not a missing task', async ($, on) => {
  const world: World = { tasks: BOARD() };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-tasks', isPlaced: true }];
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '1', ...RUN });
  const ui = await mount($);
  world.old = '1.9.3';
  await s.clock.advance(10_000);
  expect(await ui.find({ type: 'Text', text: /An older agent-tasks \(1\.9\.3\)/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /there is no task/ })).toBeUndefined();
  expect(await ui.find({ key: 'retry' })).toMatchObject({ props: { autoFocus: true } });
  // The current one back, the task is still open.
  delete world.old;
  await ui.press({ key: 'retry' });
  expect(await ui.find({ type: 'Text', text: /Write the spec/ })).toBeDefined();
});

test('a related or duplicate link is shown and opens, without blocking', async ($, on) => {
  server(on, { tasks: BOARD(), deps: [{ task_id: 2, depends_on: 1, relationship: 'related' }] });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /^Related$/ })).toBeDefined();
  expect(await ui.find({ key: 'advance:test' })).toBeDefined();
  await ui.press({ key: 'related:1' });
  expect(await ui.find({ type: 'Text', text: /Write the spec/ })).toBeDefined();
});

const STAGE_TOOL = 'mcp__plugin_agent-tasks_agent-tasks__task_stage';
const END = { reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { id: 'sess-1' } } as const;

test('the session holds the claims its agents make, beats while it runs, idle or not, and ends with it', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  const answers: { isError?: true }[] = [{}, { isError: true }, {}];
  on('tool.call', () => ({ result: 'ok', ...answers.shift() }) as never);
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }));
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.tool.call({ tool: STAGE_TOOL, action: 'claim', task_id: 3 } as never);
  // A refused claim and another tool's call adopt nothing.
  await $.tool.call({ tool: STAGE_TOOL, action: 'claim', task_id: 1 } as never);
  await $.tool.call({ tool: 'mcp__agent-tasks__task_list' } as never);
  expect(s.holds).toEqual(['POST claude:sess-1', 'POST claude:sess-1 [3]']);
  // Nothing happens in the session for a minute: it still beats.
  await s.clock.advance(60_000);
  expect(s.holds.filter((h) => h === 'POST claude:sess-1')).toHaveLength(3);
  await $.session.end(END);
  expect(s.holds.at(-1)).toBe('DELETE claude:sess-1');
});

test('a claim through the user-configured server name is held too, and a task it moves on; a finish asks what is still held', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  on('tool.call', () => ({ result: 'ok' }) as never);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  for (const action of ['assign', 'advance', 'complete'])
    await $.tool.call({ tool: 'mcp__agent-tasks__task_stage', action, task_id: 3 } as never);
  // A finish adopts nothing; it beats, so what the session holds (and the reminder) follows.
  expect(s.holds).toEqual([
    'POST claude:sess-1',
    'POST claude:sess-1 [3]',
    'POST claude:sess-1 [3]',
    'POST claude:sess-1',
  ]);
});

test('a /clear ends the conversation, not its work: the claims go on with the new session id', async ($, on) => {
  const world: World = { tasks: BOARD(), held: { 'claude:sess-1': [2] } };
  const s = server(on, world);
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }));
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await s.clock.advance(0);
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } });
  // Not ended: a /clear is no reason for its work to fail.
  expect(s.holds).not.toContain('DELETE claude:sess-1');
  world.sid = 'sess-2';
  await s.clock.advance(30_000);
  expect(s.holds).toEqual(
    expect.arrayContaining(['DELETE claude:sess-1', 'POST claude:sess-2 [2]']),
  );
  // A real end still ends the holder.
  await $.session.end({
    reason: 'prompt_input_exit',
    sessionId: 'sess-2',
    resume: { id: 'sess-2' },
  });
  expect(s.holds.at(-1)).toBe('DELETE claude:sess-2');
});

test('a session ending with the server away still ends', async ($, on) => {
  const s = server(on, { tasks: BOARD(), isDown: true });
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }));
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await s.clock.advance(0);
  await expect($.session.end(END)).resolves.toEqual({ sessionId: 'sess-1' });
});

/** The prompt as the model gets it: what beneath it was handed. */
function promptSink(on: On) {
  const seen: { context?: readonly string[]; origin: unknown }[] = [];
  on('prompt.submit', (_$, e) => (seen.push({ context: e.context, origin: e.origin }), e));
  return seen;
}

const WORK = 'Refactor the session handling so it reads more clearly';

test(
  'with enforcePipeline, a work prompt in a session that holds no task carries the reminder',
  { options: { enforcePipeline: true } },
  async ($, on) => {
    const s = server(on, { tasks: BOARD() });
    const seen = promptSink(on);
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
    await s.clock.advance(0);
    await $.prompt.submit({ text: WORK, origin: { kind: 'composer' } } as never);
    expect(seen.at(-1)).toMatchObject({ origin: { kind: 'composer' } });
    expect(seen.at(-1)!.context?.join('\n')).toContain('PIPELINE REQUIRED');
  },
);

const reminded = (seen: { context?: readonly string[] }[]) =>
  (seen.at(-1)?.context ?? []).some((c) => c.startsWith('PIPELINE REQUIRED'));

test('no reminder once the session holds a task', remind, async ($, on) => {
  const s = server(on, { tasks: BOARD(), held: { 'claude:sess-1': [1] } });
  const seen = promptSink(on);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await s.clock.advance(0);
  await $.prompt.submit({ text: WORK, origin: { kind: 'composer' } } as never);
  expect(reminded(seen)).toBe(false);
});

test(
  'no reminder for a question, a thanks, a command or a prompt the person did not send',
  remind,
  async ($, on) => {
    const s = server(on, { tasks: BOARD() });
    const seen = promptSink(on);
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
    await s.clock.advance(0);
    const asks = [
      { text: 'How does the session handling work?', origin: { kind: 'composer' } },
      { text: 'thanks, that looks great', origin: { kind: 'composer' } },
      { text: WORK, origin: { kind: 'peer', from: 'other' } },
      { text: WORK, origin: { kind: 'task-notification' } },
      {
        text: '/pipeline 3',
        origin: { kind: 'composer' },
        command: { name: 'pipeline', args: '3' },
      },
    ];
    for (const a of asks) {
      await $.prompt.submit(a as never);
      expect({ text: a.text, reminded: reminded(seen) }).toEqual({ text: a.text, reminded: false });
    }
    // A long question asks for work too.
    await $.prompt.submit({
      text: `Could you ${'rework '.repeat(40)}?`,
      origin: { kind: 'composer' },
    } as never);
    expect(reminded(seen)).toBe(true);
  },
);

test('without the option, no reminder', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  const seen = promptSink(on);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await s.clock.advance(0);
  await $.prompt.submit({ text: WORK, origin: { kind: 'composer' } } as never);
  expect(reminded(seen)).toBe(false);
});

test(
  'a server away or slow to answer lets the prompt through without a reminder',
  remind,
  async ($, on) => {
    const world: World = { tasks: BOARD(), isDown: true };
    const s = server(on, world);
    const seen = promptSink(on);
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
    await s.clock.advance(0);
    await $.prompt.submit({ text: WORK, origin: { kind: 'composer' } } as never);
    expect(reminded(seen)).toBe(false);
    world.isDown = false;
    world.isHoldHung = true;
    const sent = $.prompt.submit({ text: WORK, origin: { kind: 'composer' } } as never);
    await s.clock.advance(2_000);
    await sent;
    expect(seen).toHaveLength(2);
    expect(reminded(seen)).toBe(false);
  },
);

test(
  'once a beat answered, the reminder is decided from what the session holds, with no request',
  remind,
  async ($, on) => {
    const world: World = { tasks: BOARD() };
    const s = server(on, world);
    const seen = promptSink(on);
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
    await s.clock.advance(0);
    // A machine too busy to answer in time: nothing waits on the server now.
    world.isHoldHung = true;
    await $.prompt.submit({ text: WORK, origin: { kind: 'composer' } } as never);
    expect(reminded(seen)).toBe(true);
  },
);

test(
  'a new conversation holds nothing: its first prompt is reminded before any beat answered',
  remind,
  async ($, on) => {
    const s = server(on, { tasks: BOARD(), isHoldHung: true });
    on('session.messages', () => ({ value: [{ role: 'user', text: WORK }] }) as never);
    const seen = promptSink(on);
    await $.session.start({ cwd: '/', surface: null, isInteractive: false });
    await s.clock.advance(0);
    await $.prompt.submit({ text: WORK, origin: { kind: 'sdk' } } as never);
    expect(reminded(seen)).toBe(true);
  },
);

test(
  'a resumed conversation waits for its first beat: only the server knows its claims',
  remind,
  async ($, on) => {
    const s = server(on, { tasks: BOARD(), held: { 'claude:sess-1': [1] }, isHoldHung: true });
    on(
      'session.messages',
      () =>
        ({
          value: [
            { role: 'user', text: 'claim #1' },
            { role: 'assistant', text: 'claimed', toolUses: [] },
          ],
        }) as never,
    );
    const seen = promptSink(on);
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
    await s.clock.advance(0);
    const sent = $.prompt.submit({ text: WORK, origin: { kind: 'composer' } } as never);
    await s.clock.advance(3_000);
    await sent;
    // The beat never answered: let through, no reminder (it may hold #1).
    expect(seen).toHaveLength(1);
    expect(reminded(seen)).toBe(false);
  },
);

test('a server that hangs costs at most 3 s a request, and fails open: the board, the context, the session end', async ($, on) => {
  const world: World = { tasks: BOARD() };
  const s = server(on, world);
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }));
  on('tool.call', () => ({ result: 'ok' }) as never);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await s.clock.advance(0);
  world.isHung = true;
  const settled = async <T>(p: Promise<T>) => {
    let done = false;
    void p.then(() => (done = true));
    await s.clock.advance(2_900);
    expect(done).toBe(false);
    await s.clock.advance(200);
    return p;
  };
  const out = await settled($.command.run({ command: 'pipeline', args: '', ...RUN }));
  expect(out.text).toContain('nothing answers');
  expect(s.status.at(-1)).toBe('offline');
  await settled($.tool.call({ tool: STAGE_TOOL, action: 'claim', task_id: 3 } as never));
  await expect(settled($.session.end(END))).resolves.toEqual({ sessionId: 'sess-1' });
});

// The prompts people send, as the pipeline reminder must read them.
const WORK_PROMPTS = [
  'Can you add a reopen button for failed tasks?',
  'Could you fix the failing CI build please',
  'Go ahead and implement the plan from the spec',
  'Yes, implement it the way you proposed',
  'OK now refactor the holder sweep into its own module',
  'No, use the REST route instead and rewrite the client',
  'Push the release notes into the docs folder',
  'Status page needs a dark mode toggle, build it',
  'Add a reopen action for failed tasks?',
  'Fix the typo in the README',
  'Rename `hold` to `beat` everywhere',
  'Please update the changelog for 3.0',
  "Let's migrate the settings to the new schema",
  'Sure, do it',
  'Continue with the next step of the plan',
  'Write tests for the claim refusal',
  'The login page is broken on Firefox since yesterday',
  'Why is the build failing? Fix it.',
  'Thanks! Now add the same check to agent-knowledge.',
  'I need you to port the pane to the desktop surface',
  'Implement it',
  'Can you fix it and not touch the tests?',
  "Fix the toast, but don't change the wording",
  'Do it',
  // A go-ahead starts the work: a session holding no task is reminded then.
  'continue',
  'ok go ahead with it then',
  // Asked to know first, then to do.
  'Can you please explain why this fails and then fix it?',
  'Write the e2e harness for the real CLI',
  'Translate the README into German',
  'Run the migration on the staging database',
  'commit and push, then bump the version to 3.0.1',
  `What do you think about this? ${'We should restructure the holder service so it owns its own timer and the cleanup only purges. '.repeat(2)}`,
];
const OTHER_PROMPTS = [
  'Do you know how holders work?',
  'Can you explain the holder logic?',
  'Could you walk me through the sweep?',
  'Do not change anything, just explain how the sweep decides',
  "Don't touch the code. Why does the toast repeat?",
  'the build is failing on CI, any idea why',
  'Is the reopen artifact kept after a delete?',
  'How does the holder sweep work?',
  "What's the status of #12?",
  'Why did the e2e run fail?',
  'Is there a way to reopen a task?',
  'Does the plugin read project settings?',
  'Explain the claim holder design',
  'Show me the diff',
  'thanks, that looks great',
  'ok',
  'yes',
  'Perfect, thank you!',
  'commit',
  'commit and push',
  'git push',
  'push it',
  'status',
  'remember that the owner prefers terse commits',
  '/pipeline 12',
  '<task-notification>done</task-notification>',
  'Looks good to me',
  // Answered in the chat: nothing to track as a task.
  'Write a haiku about cats',
  'Translate this sentence into German',
  'Please give me a list of open tasks',
  'Let me know what you think about the design',
  'Quote verbatim what the error said',
  // Running the checks reads the code: no change to claim a task for.
  'Run the tests',
  'run the lint again',
];

test('the pipeline reminder reads work prompts as work and the rest as not', () => {
  const wrong = [
    ...WORK_PROMPTS.filter((p) => !isWorkPrompt(p)).map((p) => `missed: ${p}`),
    ...OTHER_PROMPTS.filter((p) => isWorkPrompt(p)).map((p) => `taken: ${p}`),
  ];
  expect(wrong).toEqual([]);
});

/** The task rows a drawing shows, top to bottom (their `open:<id>` keys). */
function rowOrder(tree: unknown): number[] {
  const out: number[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const el = n as { props?: { key?: unknown }; children?: unknown[] };
    const key = el.props?.key;
    const m = typeof key === 'string' ? /^open:(\d+)$/.exec(key) : null;
    if (m) out.push(Number(m[1]));
    for (const c of el.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

test('while the pane holds the keyboard a poll never reorders the rows under the ring; given back, they sort afresh', async ($, on) => {
  const world: World = {
    tasks: [
      task(11, 'First in the queue', { priority: 3 }),
      task(12, 'Second in the queue', { priority: 2 }),
      task(13, 'Third in the queue', { priority: 1 }),
    ],
  };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-tasks', isPlaced: true, isFocused: true } as never];
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  await s.clock.advance(5_000);
  expect(rowOrder(await ui.drawn())).toEqual([11, 12, 13]);
  // Another session raises #13 above the others: held, the rows stay where the ring saw them.
  world.tasks[2]!.priority = 9;
  world.tasks.push(task(14, 'Made elsewhere', { priority: 8 }));
  await s.clock.advance(5_000);
  expect(rowOrder(await ui.drawn())).toEqual([11, 12, 13, 14]);
  // The keys back with the prompt: the next poll sorts the board afresh.
  s.panes.value = [{ id: 'agent-tasks', isPlaced: true, isFocused: false } as never];
  await s.clock.advance(5_000);
  expect(rowOrder(await ui.drawn())).toEqual([13, 14, 11, 12]);
});

test('Done keeps its order too while held: a task finished elsewhere is added at the end', async ($, on) => {
  const world: World = {
    tasks: [
      task(21, 'Older', { status: 'completed', stage: 'done', updated_at: '2026-10-09 20:00:00' }),
      task(22, 'Newer', { status: 'completed', stage: 'done', updated_at: '2026-10-09 21:00:00' }),
      task(23, 'Still open', { status: 'in_progress', stage: 'spec', assigned_to: 'a' }),
    ],
  };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-tasks', isPlaced: true, isFocused: true } as never];
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'tab:done' });
  await s.clock.advance(5_000);
  expect(rowOrder(await ui.drawn())).toEqual([22, 21]);
  Object.assign(world.tasks[2]!, {
    status: 'completed',
    stage: 'done',
    updated_at: '2026-10-09 23:00:00',
  });
  await s.clock.advance(5_000);
  expect(rowOrder(await ui.drawn())).toEqual([22, 21, 23]);
});

test('an action form whose task changed elsewhere closes and says nothing was sent', async ($, on) => {
  const world: World = { tasks: BOARD() };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-tasks', isPlaced: true, isFocused: true } as never];
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'ask:fail' });
  expect(await ui.find({ key: 'form-submit' })).toBeDefined();
  Object.assign(world.tasks[1]!, { status: 'completed', stage: 'done' });
  await s.clock.advance(10_000);
  expect(await ui.find({ key: 'form-submit' })).toBeUndefined();
  expect(
    await ui.find({
      type: 'Text',
      text: '! #2 changed elsewhere (now completed): nothing was sent',
    }),
  ).toBeDefined();
  expect(s.calls.filter((c) => c.path === '/api/tasks/2/stage')).toEqual([]);
});

test('a form closed by a change elsewhere keeps what was typed for the same button', async ($, on) => {
  const world: World = { tasks: BOARD() };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-tasks', isPlaced: true, isFocused: true } as never];
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'complete:implement' });
  await ui.input({ key: 'form:complete', text: 'half a result', kind: 'change' });
  Object.assign(world.tasks[1]!, { stage: 'test' });
  await s.clock.advance(10_000);
  expect(await ui.find({ key: 'form-submit' })).toBeUndefined();
  expect(
    await ui.find({
      type: 'Text',
      text: '! #2 changed elsewhere (now test): nothing was sent, what you typed is kept for the form',
    }),
  ).toBeDefined();
  // Complete again: the words are back in its field; nothing was sent meanwhile.
  await ui.press({ key: 'complete:test' });
  expect((await ui.find({ key: 'form:complete' }))?.props.value).toBe('half a result');
  expect(s.calls.filter((c) => c.path === '/api/tasks/2/stage')).toEqual([]);
});

test('a task deleted elsewhere while open is a warning, and the pane goes back to the board', async ($, on) => {
  const world: World = { tasks: BOARD() };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-tasks', isPlaced: true, isFocused: true } as never];
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  world.tasks = world.tasks.filter((t) => t.id !== 2);
  await s.clock.advance(10_000);
  expect(await ui.find({ type: 'Text', text: '! #2 was deleted elsewhere' })).toBeDefined();
  expect(await ui.find({ key: 'open:1' })).toBeDefined();
});

test('delete with an open subtask below is refused up front, naming it; finished ones are counted', async ($, on) => {
  const world: World = {
    tasks: [
      ...BOARD(),
      task(5, 'Open part', { parent_id: 2, stage: 'spec', status: 'in_progress' }),
      task(6, 'Done part', { parent_id: 1, stage: 'done', status: 'completed' }),
    ],
  };
  const s = server(on, world);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  let ui = await mount($);
  await ui.press({ key: 'ask-delete' });
  expect(
    await ui.find({
      type: 'Text',
      text: '#2 has open subtasks (#5): finish, cancel or delete them first.',
    }),
  ).toBeDefined();
  expect(await ui.find({ key: 'confirm-yes' })).toBeUndefined();
  expect(await ui.find({ key: 'confirm-no' })).toBeDefined();
  await ui.unmount();
  await $.command.run({ command: 'pipeline', args: '1', ...RUN });
  ui = await mount($);
  await ui.press({ key: 'ask-delete' });
  expect(
    await ui.find({
      type: 'Text',
      text: 'Delete #1 with its artifacts, comments and 1 finished subtask? There is no undo.',
    }),
  ).toBeDefined();
  await ui.press({ key: 'confirm-yes' });
  expect(s.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/tasks/1' });
});

test('Clear on New empties the form and lands on the tab, not in Title', async ($, on) => {
  server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'tab:new' });
  await ui.press({ key: 'tab:new' }); // pressed again: to type
  expect(await ui.find({ key: 'new-title:1' })).toMatchObject({ props: { autoFocus: true } });
  await ui.press({ key: 'clear-draft' });
  // The next digit switches tabs: it is not typed into Title.
  expect((await ui.find({ key: 'new-title:2' }))?.props.autoFocus).toBeUndefined();
  expect(await ui.find({ key: 'tab:new' })).toMatchObject({ props: { autoFocus: true } });
});

test('a tab pressed while the server is down changes nothing, and says why', async ($, on) => {
  const world: World = { tasks: BOARD() };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-tasks', isPlaced: true, isFocused: true } as never];
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  world.isDown = true;
  await s.clock.advance(5_000);
  await ui.press({ key: 'tab:done' });
  expect(await ui.find({ type: 'Text', text: /^! nothing answers at http/ })).toBeDefined();
  world.isDown = false;
  await s.clock.advance(5_000);
  // Back up, the board it was on, not the tab pressed while nothing answered.
  expect(await ui.find({ key: 'open:1' })).toBeDefined();
});

test('Enter twice on a row never presses what the task view draws there (C1)', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  await s.clock.advance(1_000);
  await ui.press({ key: 'open:2' });
  // The second Enter reaches Advance, drawn where the row was: taken, and said.
  await ui.hurried({ key: 'advance:test' });
  expect(s.calls.filter((c) => c.path === '/api/tasks/2/stage')).toEqual([]);
  expect(
    await ui.find({ type: 'Text', text: /that press came as the view changed/ }),
  ).toBeDefined();
  // The person's own press, once they see the task, goes through.
  await s.clock.advance(1_000);
  await ui.press({ key: 'advance:test' });
  expect(s.calls.at(-1)).toMatchObject({
    path: '/api/tasks/2/stage',
    body: { action: 'advance', stage: 'test', from: 'implement' },
  });
});

test('Send back starts on its stage; Enter in an empty Why sends nothing; back in the queue it says so (H2)', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '1', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'ask:regress' });
  expect(await ui.find({ key: 'form-stage' })).toMatchObject({ props: { autoFocus: true } });
  // The task is in spec: the stage before is backlog, where it waits unclaimed.
  expect(
    await ui.find({
      type: 'Text',
      text: 'Back in backlog it is unclaimed: any agent may claim it.',
    }),
  ).toBeDefined();
  await ui.input({ key: 'form:regress', text: '' });
  expect(s.calls).toEqual([]);
  expect(
    await ui.find({ type: 'Text', text: '– press Send back to send it without a reason' }),
  ).toBeDefined();
  await ui.press({ key: 'form-submit' });
  expect(s.calls.at(-1)).toMatchObject({ body: { action: 'regress', stage: 'backlog' } });
});

test('a press while an act runs waits for it; a task moved elsewhere is no failure (M5, M3)', async ($, on) => {
  const world: World = { tasks: BOARD() };
  const s = server(on, world);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  // The board answers late: the act is still running when the second press comes.
  let answer: () => void = () => {};
  s.held.board = new Promise<void>((r) => (answer = r));
  const first = ui.press({ key: 'advance:test' });
  await ui.press({ key: 'advance:test' });
  // Said in the status entry; under the tabs the busy line holds the place meanwhile.
  expect(s.status).toContain('– Advancing #2 is still running: press it again when it is done');
  answer();
  await first;
  expect(s.calls.filter((c) => c.path === '/api/tasks/2/stage')).toHaveLength(1);
  // Sent back elsewhere before the next press: the drawn Advance is refused, said plainly.
  Object.assign(world.tasks[1]!, { stage: 'spec' });
  await ui.press({ key: 'advance:review' });
  expect(
    await ui.find({ type: 'Text', text: '! #2 moved elsewhere (now spec): nothing was done' }),
  ).toBeDefined();
  expect(world.tasks[1]!.stage).toBe('spec');
});

test('a session that finished its only task is reminded again (M4)', remind, async ($, on) => {
  const world: World = { tasks: BOARD(), held: { 'claude:sess-1': [2] } };
  const s = server(on, world);
  const seen = promptSink(on);
  on('tool.call', () => ({ result: 'ok' }) as never);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await s.clock.advance(0);
  await $.prompt.submit({ text: WORK, origin: { kind: 'composer' } } as never);
  expect(reminded(seen)).toBe(false);
  Object.assign(world.tasks[1]!, { status: 'completed', stage: 'done' });
  await $.tool.call({ tool: STAGE_TOOL, action: 'complete', task_id: 2 } as never);
  await $.prompt.submit({ text: WORK, origin: { kind: 'composer' } } as never);
  expect(reminded(seen)).toBe(true);
});

test('a Complete form closes when its task comes to wait for another elsewhere; a refused delete only goes back', async ($, on) => {
  const world: World = {
    tasks: [
      ...BOARD(),
      task(5, 'Open part', { parent_id: 2, status: 'in_progress', stage: 'spec' }),
    ],
  };
  const s = server(on, world);
  s.panes.value = [{ id: 'agent-tasks', isPlaced: true, isFocused: true } as never];
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'complete:implement' });
  world.deps = [{ task_id: 2, depends_on: 1, relationship: 'blocks' }];
  await s.clock.advance(10_000);
  expect(await ui.find({ key: 'form-submit' })).toBeUndefined();
  expect(
    await ui.find({ type: 'Text', text: '! #2 now waits for #1: nothing was sent' }),
  ).toBeDefined();
  await ui.press({ key: 'ask-delete' });
  expect(await ui.find({ key: 'confirm-no' })).toMatchObject({ props: { label: 'Back' } });
});

/** Text as agents paste it from tool output: colour, a title escape, a bell, a CR, NUL. */
const NOISY =
  '\u001b[31mred\u001b[0m \u001b]0;title\u0007bold\u001b[1m!\u001b[22m\r\nline\u0000end\u009b';

/** Every string the drawn tree holds, at any depth. */
function strings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const n of node) strings(n, out);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) strings(v, out);
  return out;
}

test('control characters in what agents wrote never reach a drawn text, in any view', async ($, on) => {
  const world: World = {
    tasks: [
      task(1, `Spec ${NOISY}`, {
        stage: 'spec',
        status: 'in_progress',
        assigned_to: `agent ${NOISY}`,
        description: `Steps ${NOISY}`,
        tags: JSON.stringify([`tag${NOISY}`]),
        project: 'ansi',
      }),
      task(2, `Done ${NOISY}`, { status: 'completed', stage: 'done', result: `ok ${NOISY}` }),
    ],
    comments: [
      {
        id: 7,
        task_id: 1,
        agent_id: 'agent-a',
        content: `log ${NOISY}`,
        created_at: '2026-10-09 21:00:00',
      },
    ],
    artifacts: [
      {
        id: 9,
        task_id: 1,
        stage: 'spec',
        name: `out${NOISY}`,
        content: `# Output\n${NOISY}`,
        version: 1,
        created_by: 'agent-a',
        created_at: '2026-10-09 21:00:00',
      },
    ],
  };
  server(on, world);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  const clean = async (view: string) => {
    // A drawn text the pane would still have to clean is one the CLI refuses.
    const bad = strings(await ui.drawn()).filter((x) => printable(x) !== x);
    expect({ view, bad }).toEqual({ view, bad: [] });
  };
  await clean('board');
  expect(await ui.find({ type: 'Text', text: /red bold!/ })).toBeDefined();
  await ui.press({ key: 'tab:done' });
  await clean('done');
  await ui.press({ key: 'open:2' });
  await clean('a finished task');
  await ui.press({ key: 'back' });
  await ui.press({ key: 'tab:board' });
  await ui.press({ key: 'open:1' });
  await ui.press({ key: 'art:9:shut' });
  await ui.press({ key: 'ask:fail' });
  await clean('a task with its comment, artifact and a form');
  expect(await ui.find({ type: 'Text', text: /line.end/ })).toBeDefined();
});

test('the tasks this session holds are marked on the board and in their detail', async ($, on) => {
  const s = server(on, { tasks: BOARD(), held: { 'claude:sess-1': [2] } });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await s.clock.advance(0);
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: 'this session' })).toBeDefined();
  await ui.press({ key: 'open:2' });
  expect(await ui.find({ type: 'Text', text: /this session/ })).toBeDefined();
  await ui.press({ key: 'back' });
  await ui.press({ key: 'open:1' });
  expect(await ui.find({ type: 'Text', text: /this session/ })).toBeUndefined();
});

test('Done follows the find and cuts a long result with …', async ($, on) => {
  const world: World = {
    tasks: [
      ...BOARD(),
      task(30, 'Docs pass two', {
        status: 'failed',
        stage: 'spec',
        result: 'first line\nsecond line',
        updated_at: '2026-10-09 22:00:00',
      }),
    ],
  };
  server(on, world);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: 'docs', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'tab:done' });
  expect(await ui.find({ type: 'Text', text: '1 finished task matches "docs"' })).toBeDefined();
  expect(await ui.find({ key: 'open:30' })).toBeDefined();
  expect(await ui.find({ key: 'open:4' })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: 'first line …' })).toBeDefined();
  await ui.press({ key: 'clear-filter' });
  expect(await ui.find({ key: 'open:4' })).toBeDefined();
});

test('Never mind takes its words along; a title is asked for alike; a tab is a space; hotkeys stay without the keyboard', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'ask:cancel' });
  await ui.press({ key: 'form-submit' });
  expect(await ui.find({ type: 'Text', text: '✗ a reason is needed' })).toBeDefined();
  await ui.press({ key: 'form-dismiss' });
  expect(await ui.find({ type: 'Text', text: '✗ a reason is needed' })).toBeUndefined();
  await ui.press({ key: 'tab:new' });
  await ui.press({ key: 'create' });
  expect(await ui.find({ type: 'Text', text: '✗ a title is needed' })).toBeDefined();
  expect(s.calls.filter((c) => c.path === '/api/tasks')).toEqual([]);
  const title = String((await ui.find({ type: 'Input' }))?.props.key);
  await ui.input({ key: title, text: 'Pasted\tfrom a sheet', kind: 'change' });
  await ui.press({ key: 'create' });
  expect(s.calls.at(-1)?.body).toMatchObject({ title: 'Pasted from a sheet' });
  await ui.unmount();
  const away = await $.ui.mount({
    plugin: 'agent-tasks',
    surface: 'terminal',
    component: 'Pane',
    props: { ...(pane('dock') as object), isFocused: false } as never,
    requestId: 'agent-tasks',
  });
  // Without the keyboard the hotkey labels stay: nothing reflows when the focus goes.
  expect((await away.find({ key: 'tab:board' }))?.props).toMatchObject({ hotkey: '1' });
});

test('sent back to the queue, the task says it waits to be claimed; reopened, the way back is the board', async ($, on) => {
  server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '1', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'ask:regress' });
  await ui.select({ key: 'form-stage', value: 'backlog' });
  await ui.press({ key: 'form-submit' });
  expect(
    await ui.find({ type: 'Text', text: '✓ #1 back to backlog, waiting to be claimed' }),
  ).toBeDefined();
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  await ui.press({ key: 'tab:done' });
  await ui.press({ key: 'open:4' });
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ Done' } });
  await ui.press({ key: 'reopen' });
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ Board' } });
});

test('a find shows every match with no fold toggle that would do nothing', async ($, on) => {
  const world: World = {
    tasks: Array.from({ length: 10 }, (_, i) => task(40 + i, `Queued ${i}`)),
  };
  server(on, world);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'stage:backlog:shut' });
  expect(await ui.find({ key: 'stage:backlog:open' })).toBeDefined();
  await ui.input({ key: 'find:1', text: 'Queued' });
  expect(await ui.find({ key: 'stage:backlog:open' })).toBeUndefined();
  expect(rowOrder(await ui.drawn())).toHaveLength(10);
});

const TABLE = [
  '| Phase | Owner | Status | Notes |',
  '| --- | --- | --- | --- |',
  '| 1 ledger | alice | done | moved to the new schema |',
  '| 2 pane | bob | in review | the dock at 60 columns |',
].join('\n');

test('a table artifact reads at 89 columns as a table and at 39 one row a line; a long name clips', async ($, on) => {
  server(on, {
    tasks: BOARD(),
    artifacts: [
      {
        id: 7,
        task_id: 2,
        stage: 'implement',
        name: 'a-very-long-artifact-name-for-the-implementation-notes',
        content: TABLE,
        version: 1,
        created_by: 'agent-b',
        created_at: '2026-10-09 21:00:00',
      },
    ],
  });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  for (const [columns, isTable] of [
    [89, true],
    [39, false],
  ] as const) {
    const ui = await mount($, 'terminal', columns);
    const toggle = await ui.find({ key: 'art:7:shut' });
    expect(toggle).toBeDefined();
    // The name is one line that clips, never a word split over two.
    expect(JSON.stringify(toggle)).toContain('"wrap":"truncate"');
    await ui.press({ key: 'art:7:shut' });
    const md = await ui.find({ type: 'Markdown' });
    const text = String(md?.props.text);
    if (isTable) expect(text).toBe(TABLE);
    else {
      expect(text).not.toContain('| --- |');
      expect(text).toContain('**Phase · Owner · Status · Notes**');
      expect(text).toContain('2 pane · bob · in review · the dock at 60 columns');
    }
    await ui.press({ key: 'art:7:open' });
    await ui.unmount();
  }
});

test('the ring never starts on Advance or Complete: a task opens on the way back', async ($, on) => {
  server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { autoFocus: true } });
  expect((await ui.find({ key: 'advance:test' }))?.props.autoFocus).toBeUndefined();
  // Still the step to take: drawn as the primary one.
  expect(await ui.find({ key: 'advance:test' })).toMatchObject({ props: { variant: 'primary' } });
});

test('the New tab takes the ring into Title only when the press asked to type', async ($, on) => {
  server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'tab:new' });
  expect(await ui.find({ key: 'tab:new' })).toMatchObject({ props: { autoFocus: true } });
  expect((await ui.find({ type: 'Input' }))?.props.autoFocus).toBeUndefined();
  await ui.press({ key: 'tab:new' }); // pressed again: to type
  expect((await ui.find({ type: 'Input' }))?.props.autoFocus).toBe(true);
});

test('New task on an empty board opens the form to type in', async ($, on) => {
  server(on, { tasks: [] });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'empty-new' });
  expect((await ui.find({ type: 'Input' }))?.props.autoFocus).toBe(true);
});

test('an empty Done says why and offers the next step', async ($, on) => {
  server(on, { tasks: BOARD().filter((t) => t.status !== 'completed') });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'tab:done' });
  expect(await ui.find({ type: 'Text', text: 'Nothing finished yet.' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /completed, failed or cancelled/ })).toBeDefined();
  expect(await ui.find({ key: 'empty-board' })).toMatchObject({
    props: { autoFocus: true, variant: 'primary', label: 'Board' },
  });
  await ui.press({ key: 'empty-board' });
  expect(await ui.find({ key: 'open:1' })).toBeDefined();
});

test('a delete asks with the safe button first and the ring on it; the other names what it deletes', async ($, on) => {
  server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'ask-delete' });
  const tree = JSON.stringify(await ui.drawn());
  expect(tree.indexOf('"confirm-no"')).toBeLessThan(tree.indexOf('"confirm-yes"'));
  expect(await ui.find({ key: 'confirm-no' })).toMatchObject({
    props: { label: 'Keep it', autoFocus: true },
  });
  expect(await ui.find({ key: 'confirm-yes' })).toMatchObject({ props: { label: 'Delete #2' } });
});

test('folds read ▸ N more and ▾ Show less, dimmed', async ($, on) => {
  server(on, {
    tasks: Array.from({ length: 9 }, (_, i) => task(60 + i, `Queued ${i}`)),
  });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  expect(await ui.find({ key: 'stage:backlog:shut' })).toMatchObject({
    props: { label: '▸ 4 more', dimColor: true },
  });
  await ui.press({ key: 'stage:backlog:shut' });
  expect(await ui.find({ key: 'stage:backlog:open' })).toMatchObject({
    props: { label: '▾ Show less', dimColor: true },
  });
});

test('ages count days from 24 hours; times are HH:MM today and dated before; a week is relative', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  expect(ago('2026-10-09 11:00:00', now.getTime())).toBe('1d');
  expect(ago('2026-10-10 01:00:00', now.getTime())).toBe('11h');
  expect(when('2026-10-07 12:00:00', now)).toBe('3d ago');
  expect(when('2026-09-20 12:00:00', now)).toMatch(/^2026-09-2\d \d\d:\d\d$/);
  expect(time('2026-09-20 12:00:00', now)).toMatch(/^2026-09-2\d \d\d:\d\d$/);
});
