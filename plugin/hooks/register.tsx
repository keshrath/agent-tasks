// agent-tasks inside Claude Code: the /pipeline pane (the board by stage, recently
// finished tasks, a new-task form, a task's detail with its lifecycle actions,
// artifacts and comments), a status line entry, toasts when tasks finish or reach
// review, and one context block telling the model what is in flight. Everything goes
// through the REST server every agent-tasks MCP process shares (127.0.0.1:3422).
// What the person does in the pane is done as them: `me` (AGENT_TASKS_USER, else the
// OS user name) creates, comments and moves tasks on. Claiming stays with the agents:
// the cleanup fails a task whose assignee is no live agent.
import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type {
  AgentTasksDetail,
  AgentTasksDraft,
  AgentTasksForm,
  AgentTasksRef,
  AgentTasksSnapshot,
  AgentTasksStatus,
  AgentTasksTab,
  AgentTasksTask,
} from '../types';
import {
  Pane,
  boardOrder,
  foldKey,
  headline,
  matches,
  nextStep,
  priorityOf,
  refreshKey,
  type Actions,
} from './view';

const PANE = 'agent-tasks';
const TICK_MS = 5_000;
const IDLE_TICKS = 6; // 30 s between polls while the pane is closed
const VIEW_TICKS = 2; // the open detail every 10 s
const PANE_ROWS = 40;
const ARTIFACT_MAX = 4_000;
const RECENT = 30;

const EMPTY_DRAFT: AgentTasksDraft = {
  title: '',
  project: '',
  priority: '',
  tags: '',
  description: '',
};

const snapshot = atom({ plugin: 'agent-tasks', key: 'snapshot' } as const, null);
const route = atom({ plugin: 'agent-tasks', key: 'route' } as const, {
  tab: 'board',
  task: null,
  trail: [],
});
const filter = atom({ plugin: 'agent-tasks', key: 'filter' } as const, '');
const detail = atom({ plugin: 'agent-tasks', key: 'detail' } as const, null);
const expanded = atom({ plugin: 'agent-tasks', key: 'expanded' } as const, []);
const confirm = atom({ plugin: 'agent-tasks', key: 'confirm' } as const, null);
const form = atom({ plugin: 'agent-tasks', key: 'form' } as const, null);
const draft = atom({ plugin: 'agent-tasks', key: 'draft' } as const, EMPTY_DRAFT);
const rev = atom({ plugin: 'agent-tasks', key: 'rev' } as const, 0);
const busy = atom({ plugin: 'agent-tasks', key: 'busy' } as const, null);
const notice = atom({ plugin: 'agent-tasks', key: 'notice' } as const, null);
const focused = atom({ plugin: 'agent-tasks', key: 'focused' } as const, null);

// REST bodies are server JSON; read defensively, never trusted for shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const STATUSES: AgentTasksStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'];
const status = (v: unknown): AgentTasksStatus =>
  STATUSES.includes(v as AgentTasksStatus) ? (v as AgentTasksStatus) : 'pending';
/** Tags are stored as a JSON array string. */
function tags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  try {
    const parsed: unknown = JSON.parse(String(v ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

const origin = async ($: EngineInterface) =>
  `http://127.0.0.1:${(await $.env.get('AGENT_TASKS_PORT')) ?? '3422'}`;

/** Who acts from the pane: new tasks, comments and stage moves carry this name. */
async function whoAmI($: EngineInterface): Promise<string> {
  const names = [
    await $.env.get('AGENT_TASKS_USER'),
    await $.env.get('USERNAME'),
    await $.env.get('USER'),
  ];
  return names.map((v) => v?.trim()).find(Boolean) ?? 'user';
}

async function api(
  $: EngineInterface,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<Json> {
  const res = await $.http.fetch(`${await origin($)}${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  let data: Json = {};
  try {
    data = JSON.parse(res.text) as Json;
  } catch {
    /* not JSON: the status says enough */
  }
  if (!res.ok)
    throw Object.assign(new Error(text(data.error) ?? `${method} ${path}: ${res.status}`), {
      status: res.status,
    });

  return data;
}

/** A related task; `blocked` holds the open tasks the board marks blocked. */
const ref = (t: Json, blocked: Set<number>): AgentTasksRef => ({
  id: Number(t.id),
  title: String(t.title ?? ''),
  stage: String(t.stage ?? ''),
  status: status(t.status),
  isBlocked: blocked.has(Number(t.id)),
});

async function poll($: EngineInterface): Promise<AgentTasksSnapshot> {
  const base = await origin($);
  const me = await whoAmI($);
  try {
    const b = await api($, `/api/board?recent=${RECENT}`);
    const open = list(b.open);
    const openIds = new Set(open.map((t) => Number(t.id)));
    const blockers = new Map<number, number[]>();
    for (const d of list(b.dependencies)) {
      if (d.relationship !== 'blocks' || !openIds.has(Number(d.depends_on))) continue;
      const id = Number(d.task_id);
      blockers.set(id, [...(blockers.get(id) ?? []), Number(d.depends_on)]);
    }
    const task = (t: Json): AgentTasksTask => {
      const id = Number(t.id);
      const sub = (b.subtaskProgress as Json | undefined)?.[id] as Json | undefined;
      return {
        id,
        title: String(t.title ?? ''),
        stage: String(t.stage ?? ''),
        status: status(t.status),
        priority: Number(t.priority ?? 0),
        project: text(t.project),
        assigned_to: text(t.assigned_to),
        tags: tags(t.tags),
        parent_id: typeof t.parent_id === 'number' ? t.parent_id : null,
        result: text(t.result),
        updated_at: String(t.updated_at ?? ''),
        blocked_by: blockers.get(id) ?? [],
        subtasks:
          sub && Number(sub.total) > 0
            ? { done: Number(sub.done), total: Number(sub.total) }
            : null,
      };
    };

    return {
      isUp: true,
      origin: base,
      old: null,
      stages: list(b.stages).map(String),
      pipelines: Object.fromEntries(
        Object.entries((b.pipelines ?? {}) as Record<string, unknown>).map(([p, s]) => [
          p,
          list(s).map(String),
        ]),
      ),
      open: open.map(task),
      recent: list(b.recent).map(task),
      me,
    };
  } catch (err) {
    // An agent-tasks from before the board (1.x) answers everything but /api/board.
    const old =
      (err as { status?: number }).status === 404
        ? await api($, '/health')
            .then((h) => text(h.version))
            .catch(() => null)
        : null;
    return { isUp: false, origin: base, old, stages: [], pipelines: {}, open: [], recent: [], me };
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const quoteTask = (t: AgentTasksTask) =>
  `#${t.id} "${t.title.length > 60 ? `${t.title.slice(0, 59)}…` : t.title}" [${t.stage}${t.assigned_to ? `, ${t.assigned_to}` : ''}]`;

/** The context block the model starts with: what is in flight on the shared board. */
function contextText(s: AgentTasksSnapshot) {
  const working = boardOrder(s.open.filter((t) => t.status === 'in_progress'));
  const waiting = boardOrder(s.open.filter((t) => t.status === 'pending'));
  const parts = [
    `agent-tasks pipeline (shared by every session): ${working.length} in progress${working.length ? `: ${working.slice(0, 5).map(quoteTask).join('; ')}${working.length > 5 ? `; +${working.length - 5} more` : ''}` : ''}.`,
    `${waiting.length} pending${waiting.length ? `, highest priority first: ${waiting.slice(0, 3).map(quoteTask).join('; ')}` : ''}.`,
    'Claim a task (task_stage) before working on it. The person follows the board in /pipeline.',
  ];
  return parts.join(' ');
}

const named = (t: AgentTasksTask) =>
  `#${t.id} ${t.title.length > 40 ? `${t.title.slice(0, 39).trimEnd()}…` : t.title}`;

/**
 * One toast for what finished or reached review since the last poll, the news first (a toast
 * cut short keeps it); the pane's own acts are quiet.
 */
function changes(prev: AgentTasksSnapshot, next: AgentTasksSnapshot): string | null {
  const before = new Map(prev.open.map((t) => [t.id, t]));
  const said: string[] = [];
  for (const t of next.recent) {
    if (!before.has(t.id)) continue;
    if (t.status === 'completed') said.push(`Done: ${named(t)}`);
    if (t.status === 'failed') said.push(`Failed: ${named(t)}`);
  }
  for (const t of next.open) {
    const was = before.get(t.id);
    if (was && was.stage !== t.stage && t.stage === 'review')
      said.push(`Ready for review: ${named(t)}`);
  }
  if (said.length === 0) return null;
  const shown = said.slice(0, 3).join(' · ');
  return `${shown}${said.length > 3 ? ` · +${said.length - 3} more` : ''}`;
}

/** Polls by number: one that answers after a later one was drawn is dropped, not drawn over it. */
let polls = 0;
let drawnPoll = 0;

/**
 * Polls the board and draws it. Quiet, or while an action of the pane is in flight (`busy`,
 * held by `act` until its own poll is drawn), nothing is toasted: what changed is the pane's own.
 * Going down puts the ring on Refresh; coming back up leaves it there (Enter on it is harmless)
 * and drops what a Refresh while down said.
 */
async function refresh($: EngineInterface, quiet = false) {
  const n = ++polls;
  const next = await poll($);
  const prev = await read($, snapshot);
  if (n < drawnPoll) return prev ?? next;
  drawnPoll = n;
  await update($, snapshot, () => next);
  $.ui.status(
    next.isUp ? headline(next.open) : next.old ? `old server ${next.old} on the port` : 'offline',
  );
  if (prev?.isUp && !next.isUp) void land($);
  if (prev && !prev.isUp && next.isUp) await say($, null);
  if (!quiet && prev?.isUp && next.isUp && !(await read($, busy))) {
    const said = changes(prev, next);
    if (said) $.ui.toast(said);
  }

  return next;
}

async function loadDetail($: EngineInterface, id: number) {
  const t = await api($, `/api/tasks/${id}?include=subtasks,comments`);
  const project = text(t.project);
  const snap = await read($, snapshot);
  const blocked = new Set(snap?.open.filter((x) => x.blocked_by.length).map((x) => x.id));
  // The parent as the board has it (open or recently finished); asked for only otherwise.
  const parentId = typeof t.parent_id === 'number' ? t.parent_id : null;
  const known = [...(snap?.open ?? []), ...(snap?.recent ?? [])].find((x) => x.id === parentId);
  const [pipeline, parent] = await Promise.all([
    api($, `/api/pipeline${project ? `?project=${encodeURIComponent(project)}` : ''}`),
    known || parentId === null
      ? (known ?? null)
      : api($, `/api/tasks/${parentId}`).catch(() => null),
  ]);
  const deps = (t.dependencies ?? {}) as Json;
  const next: AgentTasksDetail = {
    id,
    title: String(t.title ?? ''),
    description: String(t.description ?? ''),
    stage: String(t.stage ?? ''),
    status: status(t.status),
    priority: Number(t.priority ?? 0),
    project,
    assigned_to: text(t.assigned_to),
    tags: tags(t.tags),
    result: text(t.result),
    created_by: String(t.created_by ?? ''),
    created_at: String(t.created_at ?? ''),
    updated_at: String(t.updated_at ?? ''),
    parent: parent ? ref(parent, blocked) : null,
    stages: list(pipeline.stages).map(String),
    blockers: list(deps.blockers).map((x) => ref(x, blocked)),
    blocking: list(deps.blocking).map((x) => ref(x, blocked)),
    links: list(deps.links).map((l) => ({
      ...ref((l.task ?? {}) as Json, blocked),
      relationship: String(l.relationship ?? ''),
    })),
    subtasks: list(t.subtasks).map((x) => ref(x, blocked)),
    // Newest version of each artifact name, newest first.
    artifacts: list(t.artifacts)
      .filter((a, i, all) => !all.some((b, j) => j > i && b.name === a.name && b.stage === a.stage))
      .reverse()
      .map((a) => {
        const content = String(a.content ?? '');
        return {
          id: Number(a.id),
          stage: String(a.stage ?? ''),
          name: String(a.name ?? ''),
          version: Number(a.version ?? 1),
          created_by: String(a.created_by ?? ''),
          created_at: String(a.created_at ?? ''),
          content: content.slice(0, ARTIFACT_MAX),
          cut: Math.max(0, content.length - ARTIFACT_MAX),
        };
      }),
    commentCount: Number(t.comments_count ?? 0),
    comments: list(t.comments).map((c) => ({
      id: Number(c.id),
      author: String(c.agent_id ?? ''),
      content: String(c.content ?? ''),
      created_at: String(c.created_at ?? ''),
    })),
  };
  await update($, detail, () => next);
}

/**
 * Reloads the open detail; a task deleted elsewhere (or never made) returns to the list. With
 * no board up there is no detail to load: the 404 of a server from before the board is not
 * the task's.
 */
async function loadView($: EngineInterface) {
  const r = await read($, route);
  if (r.task === null || !(await read($, snapshot))?.isUp) return;
  try {
    await loadDetail($, r.task);
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
    await update($, route, (x) => ({ ...x, task: null, trail: [] }));
    say($, `✗ there is no task #${r.task}`);
    void land($);
  }
}

const NOTICE_MS = 10_000;
/** Notices by number: only the one still shown when its time is up is taken away. */
let notices = 0;

/** Puts an outcome in the status line, or takes it away; it goes by itself after NOTICE_MS. */
async function say($: EngineInterface, said: string | null) {
  const n = ++notices;
  await update($, notice, () => said);
  if (said)
    void $.clock
      .sleep(NOTICE_MS)
      .then(async () => (n === notices ? say($, null) : undefined))
      .catch(() => undefined);
}

/**
 * Runs one action with its busy line and outcome, then reloads and lands the focus: on `to`'s
 * key when given (the comment field after a comment), else where `landing` says. The busy
 * line stays until the reload is drawn: a poll answering meanwhile does not toast the action.
 * The outcome leads with its mark: ✓ done, or the task's own look (a failed task's ✗).
 */
async function act(
  $: EngineInterface,
  label: string,
  fn: () => Promise<string>,
  to?: () => Promise<string>,
) {
  await update($, busy, () => label);
  await say($, null);
  try {
    await say($, (await fn()) || null);
  } catch (err) {
    await say($, `✗ ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const snap = await refresh($, true);
  // Refresh pressed while still down: say it was tried, and when.
  if (!snap.isUp && !(await read($, notice)))
    await say($, `✗ still no board (${new Date().toTimeString().slice(0, 8)})`);
  await loadView($).catch(() => {});
  await update($, busy, () => null);
  if (to) await focusOn($, await to());
  else void land($);
}

/** Where the focus ring lands: the control the person most likely wants next. */
async function landing($: EngineInterface, from: number | null): Promise<string | null> {
  const snap = await read($, snapshot);
  if (!snap?.isUp) return refreshKey(false);
  const r = await read($, route);
  if (r.task !== null) {
    const f = await read($, form);
    if (f?.task === r.task) return `form:${f.action}`;
    const c = await read($, confirm);
    if (c) return 'confirm-no';
    const d = await read($, detail);
    if (!d || d.id !== r.task) return 'back';
    return nextStep(d) ?? 'back';
  }
  if (r.tab === 'new') return `new-title:${await read($, rev)}`;
  if (r.tab === 'done') {
    const to = from !== null && snap.recent.some((t) => t.id === from) ? from : snap.recent[0]?.id;
    return to !== undefined ? `open:${to}` : 'tab:board';
  }
  const q = await read($, filter);
  const shown = boardOrder(
    snap.open.filter((t) => matches(t, q)),
    snap,
  );
  const to = from !== null && shown.some((t) => t.id === from) ? from : shown[0]?.id;
  if (to !== undefined) return `open:${to}`;
  return snap.open.length ? 'clear-filter' : 'empty-new';
}

/**
 * Moves the ring and keeps where it went: the pane's own moves do not reach its `ui.focus`
 * hook (the person's do), and the header says when the keys go into a text field.
 */
async function focusOn($: EngineInterface, key: string) {
  const r = await $.ui.focus({ requestId: PANE, key }).catch(() => ({ deny: 'not drawn' }));
  if (!('deny' in r)) await update($, focused, () => key);
}

async function land($: EngineInterface, from: number | null = null) {
  const key = await landing($, from);
  if (key) await focusOn($, key);
}

/**
 * Lands the ring on a board drawn after the last `rev` bump. A key already drawn is focused at
 * once, and the ring keeps its place, not its key, across a redraw: a row the board before
 * drew too, elsewhere, would take it to whatever then sits there. The Find field's fresh key
 * exists only in the new board, so focusing it waits for that drawing first.
 */
async function landOnNewBoard($: EngineInterface) {
  await focusOn($, `find:${await read($, rev)}`);
  await land($);
}

/** Narrows the board to `query` and lands on the first row it shows. */
async function refilter($: EngineInterface, query: string) {
  await update($, filter, () => query);
  await say($, null);
  await update($, rev, (n) => n + 1);
  await landOnNewBoard($);
}

async function reset($: EngineInterface) {
  await update($, confirm, () => null);
  await update($, form, () => null);
  await say($, null);
}

async function go($: EngineInterface, tab: AgentTasksTab) {
  const from = (await read($, route)).task;
  await update($, route, () => ({ tab, task: null, trail: [] }));
  await reset($);
  void land($, from);
}

async function open($: EngineInterface, id: number) {
  const r = await read($, route);
  const trail = r.task !== null && r.task !== id ? [...r.trail, r.task] : r.trail;
  await update($, route, () => ({ ...r, task: id, trail }));
  await reset($);
  await update($, expanded, () => []);
  if ((await read($, detail))?.id !== id) await update($, detail, () => null);
  await loadView($).catch(async (err: Error) => say($, `✗ ${err.message}`));
  void land($);
}

async function back($: EngineInterface) {
  const r = await read($, route);
  const prev = r.trail.at(-1);
  if (prev !== undefined) {
    await update($, route, () => ({ ...r, task: prev, trail: r.trail.slice(0, -1) }));
    await reset($);
    await loadView($).catch(() => {});
    void land($);
    return;
  }
  await update($, route, () => ({ ...r, task: null, trail: [] }));
  await reset($);
  void land($, r.task);
}

/**
 * Opens the pane afresh with the keys. An open pane is closed first: taking the keys again
 * would put the ring back on the element it last held (a control the new view draws too,
 * or one like it), not on the view's autoFocus element.
 */
async function openPane($: EngineInterface) {
  await $.ui.close({ id: PANE }).catch(() => undefined);
  return $.ui.open({ id: PANE, title: 'agent-tasks', focus: true, rows: PANE_ROWS });
}

/** Creates the task the New tab holds and opens it. */
async function create($: EngineInterface): Promise<string> {
  const d = await read($, draft);
  const title = d.title.trim();
  if (!title) throw new Error('a title is needed');
  const tagList = d.tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const t = await api($, '/api/tasks', 'POST', {
    title,
    priority: priorityOf(d) ?? 0,
    created_by: (await read($, snapshot))?.me,
    ...(d.project.trim() ? { project: d.project.trim() } : {}),
    ...(d.description.trim() ? { description: d.description.trim() } : {}),
    ...(tagList.length ? { tags: tagList } : {}),
  });
  await update($, draft, () => EMPTY_DRAFT);
  await update($, rev, (n) => n + 1);
  await refresh($, true);
  await update($, route, () => ({ tab: 'board' as const, task: Number(t.id), trail: [] }));
  await update($, detail, () => null);
  return `✓ created #${t.id}`;
}

/**
 * Creates the task, unless its priority is no whole number: then the ring goes back to that
 * field, which says so beneath it.
 */
async function submit($: EngineInterface) {
  if (priorityOf(await read($, draft)) !== null)
    return act($, 'create task', async () => create($));
  await update($, rev, (n) => n + 1);
  await focusOn($, `new-priority:${await read($, rev)}`);
}

/** Closes the open form or confirmation and puts the ring back on the button that opened it. */
async function dismiss($: EngineInterface) {
  const f = await read($, form);
  await update($, form, () => null);
  await update($, confirm, () => null);
  await focusOn($, f ? `ask:${f.action}` : 'ask-delete');
}

/**
 * Unfolds or folds a part of the detail; the ring stays on its toggle (see `foldKey`). An
 * artifact unfolds below its toggle, often below the window: the pane scrolls to show it.
 */
async function toggle($: EngineInterface, part: string) {
  await update($, expanded, (x) => (x.includes(part) ? x.filter((p) => p !== part) : [...x, part]));
  const isOpen = (await read($, expanded)).includes(part);
  await focusOn($, foldKey(part, isOpen));
  if (isOpen && part.startsWith('art:'))
    await $.ui.scroll({ in: PANE, to: { key: `artrow:${part.slice(4)}` } }).catch(() => undefined);
}

function actions($: EngineInterface): Actions {
  const run = (label: string, fn: () => Promise<string>, to?: () => Promise<string>) =>
    void act($, label, fn, to);
  const stage = async (id: number, body: Json) =>
    api($, `/api/tasks/${id}/stage`, 'POST', { ...body, by: (await read($, snapshot))?.me });
  const finish = (id: number, action: AgentTasksForm['action'], words: string) => {
    const said = words.trim();
    if (!said && action !== 'regress') {
      void say(
        $,
        `✗ ${action === 'cancel' ? 'a reason' : action === 'fail' ? 'what went wrong' : 'a result'} is needed`,
      );
      return;
    }
    run(
      `${action} #${id}`,
      async () => {
        if (action === 'regress') {
          const to = (await read($, form))?.stage;
          if (!to) throw new Error('pick the stage to go back to');
          await stage(id, { action, stage: to, ...(said ? { reason: said } : {}) });
          await update($, form, () => null);
          return `✓ #${id} back to ${to}`;
        }
        await stage(id, action === 'cancel' ? { action, reason: said } : { action, result: said });
        await update($, form, () => null);
        return {
          complete: `✓ #${id} completed`,
          fail: `✗ #${id} failed`,
          cancel: `– #${id} cancelled`,
        }[action];
      },
      // Sent back, it offers Advance again: the ring goes to the way out, not onto undoing it.
      action === 'regress' ? async () => 'back' : undefined,
    );
  };

  return {
    refresh: () => run('refresh', async () => ''),
    go: (tab) => void go($, tab),
    open: (id) => void open($, id),
    back: () => void back($),
    find: (q) => void refilter($, q.trim()),
    clearFilter: () => void refilter($, ''),
    // The stage the button names: a second press before the redraw is refused, not a skip.
    advance: (id, to) =>
      run(`advance #${id}`, async () => {
        const t = await stage(id, { action: 'advance', stage: to });
        return `✓ #${id} moved to ${t.stage}`;
      }),
    ask: (id, action) =>
      void (async () => {
        const d = await read($, detail);
        const idx = d ? d.stages.indexOf(d.stage) : -1;
        await update($, confirm, () => null);
        await say($, null);
        await update($, form, () => ({
          action,
          task: id,
          stage: action === 'regress' && d && idx > 0 ? d.stages[idx - 1] : null,
          words: '',
        }));
        await land($);
      })(),
    // The stage picked, the ring moves on to the note.
    pickStage: (s) =>
      void (async () => {
        await update($, form, (f) => f && { ...f, stage: s });
        await focusOn($, 'form:regress');
      })(),
    finish: (id, action, words) => finish(id, action, words),
    type: (words) => void update($, form, (f) => f && { ...f, words }),
    dismiss: () => void dismiss($),
    askDelete: (id) =>
      void (async () => {
        await update($, form, () => null);
        await update($, confirm, () => `delete:${id}`);
        await land($);
      })(),
    remove: (id) =>
      run(`delete #${id}`, async () => {
        await api($, `/api/tasks/${id}`, 'DELETE');
        await update($, confirm, () => null);
        const r = await read($, route);
        await update($, route, () => ({ ...r, task: null, trail: [] }));
        await update($, detail, () => null);
        return `✓ #${id} deleted`;
      }),
    comment: (id, words) => {
      const said = words.trim();
      if (!said) return;
      run(
        `comment on #${id}`,
        async () => {
          await api($, `/api/tasks/${id}/comments`, 'POST', {
            content: said,
            agent_id: (await read($, snapshot))?.me,
          });
          return `✓ comment added to #${id}`;
        },
        // A fresh field, keyed after the reload: the ring waits for the drawing with the
        // comment in it (one that adds `▸ n earlier` above the field would move it).
        async () => {
          await update($, rev, (n) => n + 1);
          return `comment:${await read($, rev)}`;
        },
      );
    },
    toggle: (part) => void toggle($, part),
    edit: (field, value) => void update($, draft, (d) => ({ ...d, [field]: value })),
    submitField: (field, value, next) =>
      void (async () => {
        await update($, draft, (d) => ({ ...d, [field]: value }));
        await update($, rev, (n) => n + 1);
        // The last field creates; a priority that is no number is said at once, kept there.
        if (next === null || (field === 'priority' && priorityOf(await read($, draft)) === null))
          return void submit($);
        await say($, null);
        const key = `new-${next}:${await read($, rev)}`;
        await focusOn($, key);
      })(),
    create: () => void submit($),
    clearDraft: () =>
      void (async () => {
        await update($, draft, () => EMPTY_DRAFT);
        await update($, rev, (n) => n + 1);
        await land($);
      })(),
  };
}

export const register: Register = (on) => {
  let isPolling = false;
  let ticks = 0;
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pipeline',
      description: 'The agent-tasks board: tasks by stage, details, advance, comment',
      argumentHint: '[task id or text to find]',
    });
    void refresh($, true);
    $.clock.every(TICK_MS, async () => {
      ticks += 1;
      const shown = (await $.ui.panes()).some((p) => p.id === PANE && p.isPlaced);
      if (isPolling || !(shown || ticks % IDLE_TICKS === 0)) return;
      isPolling = true;
      try {
        await refresh($);
        if (shown && ticks % VIEW_TICKS === 0) await loadView($).catch(() => {});
      } finally {
        isPolling = false;
      }
    });

    return next(e);
  });

  on('command.run', { command: 'pipeline' }, async ($, e) => {
    const snap = await refresh($, true);
    const lines = [
      snap.isUp
        ? headline(snap.open)
        : snap.old
          ? `agent-tasks ${snap.old} holds ${snap.origin} and has no board: end the sessions still running it`
          : `nothing answers at ${snap.origin}: is the agent-tasks MCP server connected (/mcp)?`,
    ];
    // The view is set before the pane opens: its autoFocus element is where the ring starts.
    // The text found is the command's own: a plain /pipeline or a task id clears the last one.
    const arg = e.args.trim().replace(/^#/, '');
    const isId = /^\d+$/.test(arg);
    if (snap.isUp) await update($, filter, () => (isId ? '' : arg));
    if (snap.isUp && isId) {
      await update($, route, () => ({ tab: 'board' as const, task: null, trail: [] }));
      await open($, Number(arg));
      const n = await read($, notice);
      if (n?.startsWith('✗')) lines.push(n.slice(2));
    } else if (snap.isUp) {
      await update($, route, () => ({ tab: 'board' as const, task: null, trail: [] }));
      await reset($);
      await update($, rev, (n) => n + 1);
      if (arg) {
        const hits = snap.open.filter((t) => matches(t, arg)).length;
        lines.push(`${plural(hits, 'open task')} ${hits === 1 ? 'matches' : 'match'} "${arg}"`);
      }
    }
    const opened = await openPane($);
    if (!opened.isPlaced) lines.push(`pane not shown: ${opened.reason}`);
    // The take can land on a drawing from before the find; the board's own landing follows it.
    else if (snap.isUp && !isId) await landOnNewBoard($);

    return { text: lines.join('\n') };
  });

  // Where the person moves the ring (Tab, a click): the header says when keys go into a field.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const r = await next(e);
    if (!('deny' in r)) await update($, focused, () => e.element ?? null);
    return r;
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e);
    const snap = await read($, snapshot);
    if (!snap) return <el.Text dimColor>Loading…</el.Text>;

    return (
      <Pane
        el={el}
        snap={snap}
        route={await read($, route)}
        filter={await read($, filter)}
        detail={await read($, detail)}
        expanded={await read($, expanded)}
        confirm={await read($, confirm)}
        form={await read($, form)}
        draft={await read($, draft)}
        rev={await read($, rev)}
        busy={await read($, busy)}
        notice={await read($, notice)}
        focused={await read($, focused)}
        isFocused={e.props.isFocused}
        columns={e.props.bodyColumns}
        landing={await landing($, null)}
        on={actions($)}
      />
    );
  });

  on('prompt.context', async ($, e, next) => {
    const r = await next(e);
    const snap = (await read($, snapshot)) ?? (await refresh($, true));
    if (!snap.isUp) return r;

    return { ...r, blocks: [...r.blocks, { name: 'agent-tasks', text: contextText(snap) }] };
  });
};
