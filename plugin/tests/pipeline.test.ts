import type { On } from 'claude-code';
import { expect, mock, test, type TestBody } from 'claude-code/testing';

import { isField, packParts } from '../hooks/view';

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
  const clock = mock.clock(on);
  mock.env(on, { AGENT_TASKS_USER: 'mathi' });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url);
    const method = e.init?.method ?? 'GET';
    const body = e.init?.body ? (JSON.parse(e.init.body) as Record<string, unknown>) : undefined;
    if (method !== 'GET') calls.push({ method, path: url.pathname, body });
    const reply = (data: unknown, code = 200) => ({
      value: { status: code, ok: code < 400, headers: {}, text: JSON.stringify(data) },
    });
    if (world.isDown) return reply({ error: 'connection refused' }, 502);
    const p = url.pathname;
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
      if (a === 'advance') {
        if ((world.deps ?? []).some((d) => d.task_id === one.id))
          return reply({ error: 'Blocked by incomplete dependencies: #2' }, 409);
        const to = body?.stage ? STAGES.indexOf(String(body.stage)) : at + 1;
        if (to <= at) return reply({ error: `Target stage '${body?.stage}' is not ahead` }, 422);
        Object.assign(one, { stage: STAGES[to], status: 'in_progress' });
      } else if (a === 'regress') Object.assign(one, { stage: body?.stage });
      else if (a === 'complete')
        Object.assign(one, { status: 'completed', stage: 'done', result: body?.result });
      else if (a === 'fail') Object.assign(one, { status: 'failed', result: body?.result });
      else if (a === 'cancel')
        Object.assign(one, { status: 'cancelled', stage: 'cancelled', result: body?.reason });
      one.updated_at = '2026-10-09 22:00:00';
      return reply(one);
    }

    return reply({ error: 'Not found' }, 404);
  });
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  on('ui.status', (_$, e) => (status.push(e.text), { value: undefined }));
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }));
  on('ui.open', (_$, e) => (opens.push({ ...e }), { value: placed.value }) as never);
  const panes = { value: [] as { id: string; isPlaced: boolean }[] };
  on('ui.panes', () => ({ value: panes.value }) as never);
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}));
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }));

  return { calls, toasts, held, status, opens, placed, panes, clock };
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

function mount<S extends Surface = 'terminal'>(
  $: Engine,
  surface: S = 'terminal' as S,
  columns = 58,
) {
  return $.ui.mount({
    plugin: 'agent-tasks',
    surface,
    component: 'Pane',
    props: pane('dock', columns),
    requestId: 'agent-tasks',
  });
}

test('/pipeline opens a plain sidebar pane with the board on every surface', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const out = await $.command.run({ command: 'pipeline', args: '', ...RUN });
  expect(out.text).toBe('3 open tasks · 2 in progress');
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
});

test('/pipeline says why when the pane is not placed', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  s.placed.value = { isPlaced: false, reason: 'below 110 columns' };
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const out = await $.command.run({ command: 'pipeline', args: '', ...RUN });
  expect(out.text).toContain('pane not shown: below 110 columns');
});

test('Find narrows the board by id, title, agent, project or tag; a blocked task says what it waits for', async ($, on) => {
  server(on, { tasks: BOARD(), deps: [{ task_id: 2, depends_on: 1, relationship: 'blocks' }] });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const out = await $.command.run({ command: 'pipeline', args: 'docs', ...RUN });
  expect(out.text).toContain('1 open task matches "docs"');
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
  expect(await ui.find({ key: 'open:3' })).toMatchObject({ props: { autoFocus: true } });
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
    body: { action: 'advance', stage: 'test', by: 'mathi' },
  });
  expect(await ui.find({ type: 'Text', text: /#2 moved to test/ })).toBeDefined();
  await ui.press({ key: 'advance:review' });
  expect(await ui.find({ key: 'advance:done' })).toBeUndefined(); // review: the next step is done
  await ui.press({ key: 'ask:complete' });
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
  expect(await ui.find({ key: 'ask:complete' })).toBeUndefined();
  expect(await ui.find({ key: 'ask:fail' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /It moves on once #1 is done/ })).toBeDefined();
  await ui.press({ key: 'dep:1' });
  expect(await ui.find({ type: 'Text', text: /Write the spec/ })).toBeDefined();
  expect(await ui.find({ key: 'back' })).toMatchObject({ props: { label: '‹ #2' } });
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

test('new task: Enter walks the fields; Create posts and opens the task', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'tab:new' });
  await ui.input({ key: 'new-title:1', text: 'Try the pane' });
  expect(await ui.find({ key: 'new-title:2' })).toMatchObject({ props: { value: 'Try the pane' } });
  await ui.input({ key: 'new-project:2', text: 'agent-tasks' });
  // A priority that is no number is said at its own field, kept there (e2e checks the ring).
  await ui.input({ key: 'new-priority:3', text: 'high' });
  expect(await ui.find({ type: 'Text', text: /a whole number, like 0 or 5/ })).toBeDefined();
  expect(await ui.find({ key: 'new-priority:5' })).toMatchObject({ props: { value: 'high' } });
  await ui.press({ key: 'create' });
  expect(s.calls).toEqual([]);
  await ui.input({ key: 'new-priority:6', text: '3' });
  expect(await ui.find({ type: 'Text', text: /a whole number, like 0 or 5/ })).toBeUndefined();
  await ui.press({ key: 'create' });
  expect(s.calls.at(-1)).toEqual({
    method: 'POST',
    path: '/api/tasks',
    body: { title: 'Try the pane', priority: 3, created_by: 'mathi', project: 'agent-tasks' },
  });
  expect(await ui.find({ type: 'Text', text: 'Try the pane' })).toBeDefined(); // its detail
  await ui.press({ key: 'tab:new' });
  expect(await ui.find({ key: 'new-title:8' })).toMatchObject({ props: { value: '' } });
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
  expect(s.toasts).toEqual(['Done: #1 Write the spec · Ready for review: #2 Ship the pane']);
  await s.clock.advance(30_000);
  expect(s.toasts).toHaveLength(1);
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
  expect(await ui.find({ key: 'ask:complete' })).toBeUndefined();
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
  expect(await ui.find({ type: 'Text', text: /still no board \(\d\d:\d\d:\d\d\)/ })).toBeDefined();
  world.isDown = false;
  await ui.press({ key: 'retry' });
  expect(await ui.find({ key: 'open:3' })).toMatchObject({ props: { autoFocus: true } });
});

test('an agent-tasks from before the board on the port is named, not taken for nothing', async ($, on) => {
  const s = server(on, { tasks: BOARD(), old: '1.9.3' });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const out = await $.command.run({ command: 'pipeline', args: '', ...RUN });
  expect(out.text).toContain('agent-tasks 1.9.3 holds http://127.0.0.1:3422');
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

test('the model starts with what is in flight', async ($, on) => {
  server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const r = await $.prompt.context({ blocks: [] });
  const block = r.blocks.find((b) => b.name === 'agent-tasks');
  expect(block?.text).toContain('2 in progress: #1 "Write the spec" [spec, agent-a]');
  expect(block?.text).toContain('1 pending, highest priority first: #3 "Docs pass" [backlog]');
});

test('the tab shown takes its own key: the ring lands on its first row, nothing leaks', async ($, on) => {
  server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '', ...RUN });
  const ui = await mount($);
  expect(await ui.find({ key: 'tab:board' })).toMatchObject({
    type: 'Button',
    props: { hotkey: '1' },
  });
  // Pressed again it keeps the view (e2e checks the ring lands on the first row).
  await ui.press({ key: 'tab:board' });
  expect(await ui.find({ key: 'open:3' })).toMatchObject({ props: { autoFocus: true } });
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

test('a failed task is said in its own look, and an outcome goes after a while', async ($, on) => {
  const s = server(on, { tasks: BOARD() });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'pipeline', args: '2', ...RUN });
  const ui = await mount($);
  await ui.press({ key: 'ask:fail' });
  await ui.input({ key: 'form:fail', text: 'gone' });
  expect(await ui.find({ type: 'Text', text: '✗ #2 failed' })).toMatchObject({
    props: { color: 'error' },
  });
  await s.clock.advance(10_000);
  expect(await ui.find({ type: 'Text', text: /#2 failed/ })).toBeUndefined();
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
