// agent-tasks inside Claude Code: the /pipeline pane (the board by stage, recently
// finished tasks, a new-task form, a task's detail with its lifecycle actions,
// artifacts and comments), a status line entry, toasts when tasks finish or reach
// review, and one context block telling the model what is in flight. Everything goes
// through the REST server every agent-tasks MCP process shares (127.0.0.1:3422).
// What the person does in the pane is done as them: `me` (AGENT_TASKS_USER, else the
// OS user name) creates, comments and moves tasks on. Claiming stays with the agents.
// The session holds the claims made in it (the server's claim holders): it adopts each
// claim its agents make through task_stage, beats while it runs, idle or not, and ends
// its holder when it ends; a task whose session is gone fails after the server's grace.
// With the enforcePipeline option, a prompt asking for work in a session that holds no
// open task carries a reminder to claim one first.
import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type {
  AgentTasksDetail,
  AgentTasksDraft,
  AgentTasksForm,
  AgentTasksGate,
  AgentTasksPinned,
  AgentTasksRef,
  AgentTasksSnapshot,
  AgentTasksStatus,
  AgentTasksTab,
  AgentTasksTask,
} from '../types';
import {
  COMMENTS_SHOWN,
  Pane,
  activeStages,
  boardGroups,
  boardOrder,
  clip,
  FOLD_ROWS,
  foldKey,
  headline,
  matches,
  completeKey,
  formKey,
  isField,
  isOutOfReach,
  isRisky,
  matches as matchesFind,
  nextStep,
  pinOrder,
  printable,
  priorityOf,
  refreshKey,
  type Actions,
} from './view';
import { PIPELINE_REMINDER, isWorkPrompt } from './work';

const PANE = 'agent-tasks';
const TICK_MS = 5_000;
const IDLE_TICKS = 6; // 30 s between polls while the pane is closed
const VIEW_TICKS = 2; // the open detail every 10 s
const PANE_ROWS = 40;
const ARTIFACT_MAX = 4_000;
const RECENT = 30;
const BEAT_TICKS = 6; // the session's holder beats every 30 s
const PROMPTED_BY_PERSON = new Set(['composer', 'bridge', 'sdk']);
const REMIND_WITHIN_MS = 2_000;
const FETCH_TIMEOUT_MS = 3_000;

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
const frame = atom({ plugin: 'agent-tasks', key: 'frame' } as const, 0);
const busy = atom({ plugin: 'agent-tasks', key: 'busy' } as const, null);
const notice = atom({ plugin: 'agent-tasks', key: 'notice' } as const, null);
const focused = atom({ plugin: 'agent-tasks', key: 'focused' } as const, null);
const pinned = atom({ plugin: 'agent-tasks', key: 'pinned' } as const, null);
const mine = atom({ plugin: 'agent-tasks', key: 'mine' } as const, []);

// REST bodies are server JSON; read defensively, never trusted for shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The server's `gate_needs`: what holds the task in its stage. */
function gateOf(v: unknown): AgentTasksGate | null {
  if (!v || typeof v !== 'object') return null;
  const g = v as Json;
  return {
    comment: Boolean(g.comment),
    artifact: Boolean(g.artifact),
    artifacts: list(g.artifacts).map(String),
    more: Number(g.min_artifacts ?? 0),
    approval: Boolean(g.approval),
  };
}
const STATUSES: AgentTasksStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'];
const status = (v: unknown): AgentTasksStatus =>
  STATUSES.includes(v as AgentTasksStatus) ? (v as AgentTasksStatus) : 'pending';
/** Tags are stored as a JSON array string. */
function tags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  try {
    // Tags arrive as JSON text inside the answer: their own strings are made drawable here.
    const parsed: unknown = JSON.parse(String(v ?? '[]'));
    return Array.isArray(parsed) ? parsed.map((x) => printable(String(x))) : [];
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
  const res = await Promise.race([
    $.http.fetch(`${await origin($)}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    }),
    $.clock.sleep(FETCH_TIMEOUT_MS).then(() => {
      throw Object.assign(new Error(`${method} ${path}: no answer in ${FETCH_TIMEOUT_MS} ms`), {
        status: 504,
      });
    }),
  ]);
  let data: Json = {};
  try {
    // Every text the server answers enters the pane here, made drawable once (`printable`).
    data = JSON.parse(res.text, (_, v: unknown) =>
      typeof v === 'string' ? printable(v) : v,
    ) as Json;
  } catch {
    /* not JSON: the status says enough */
  }
  if (!res.ok)
    throw Object.assign(new Error(text(data.error) ?? `${method} ${path}: ${res.status}`), {
      status: res.status,
    });

  return data;
}

const holderPath = (sessionId: string) =>
  `/api/holders/${encodeURIComponent(`claude:${sessionId}`)}`;

/**
 * Beats this session's holder, adopting the tasks in `adopt`: resolves to the open tasks
 * it holds, null while the server is away.
 */
/**
 * Whether `mine` says what this session holds: true once a beat answered. Its claims reach it
 * through the beats (every 30 s) and each claim its agents make (adopted at once), so a prompt
 * is judged from it with no request of its own.
 */
let isMineKnown = false;

/** The latest beat of this session's holder: what it holds, null while the server is away. */
let held: Promise<Json[] | null> = Promise.resolve(null);

async function hold($: EngineInterface, adopt: number[] = []): Promise<Json[] | null> {
  try {
    const carried = await carryOver($);
    const all = [...carried, ...adopt];
    const r = await api(
      $,
      holderPath(await $.session.id()),
      'POST',
      all.length ? { adopt: all } : {},
    );
    const held = list(r.held);
    await update($, mine, () => held.map((t) => Number(t.id)));
    isMineKnown = true;
    return held;
  } catch {
    return null;
  }
}

/**
 * The conversation a /clear ended (its session id): the process goes on under a new id, and
 * the work claimed before the /clear goes on with it. Its holder is not ended; the next beat
 * moves what it holds to the new one.
 */
let clearedFrom: string | null = null;

/** The tasks the conversation before a /clear held, now this one's to hold; [] when none. */
async function carryOver($: EngineInterface): Promise<number[]> {
  const from = clearedFrom;
  if (!from || from === (await $.session.id())) return [];
  const before = await api($, holderPath(from), 'POST', {});
  clearedFrom = null;
  await api($, holderPath(from), 'DELETE').catch(() => {});
  return list(before.held).map((t) => Number(t.id));
}

/** A task_stage call of agent-tasks' MCP server, by whichever name the host gave it. */
const isTaskStage = (tool: string) => /agent-tasks__task_stage$/.test(tool);

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

const quoteTask = (t: AgentTasksTask, own: Set<number>) =>
  `#${t.id} "${t.title.length > 60 ? `${t.title.slice(0, 59)}…` : t.title}" [${t.stage}${t.assigned_to ? `, ${t.assigned_to}` : ''}${own.has(t.id) ? ', this session' : ''}]`;

/**
 * The context block the model starts with (once per conversation): what is in flight on the
 * shared board, this session's own claims marked first. It asks the model to claim only when
 * the person turned the pipeline reminder on; otherwise it says how, nothing more.
 */
function contextText(s: AgentTasksSnapshot, own: Set<number>, isEnforced: boolean) {
  const working = boardOrder(s.open.filter((t) => t.status === 'in_progress')).sort(
    (a, b) => Number(own.has(b.id)) - Number(own.has(a.id)),
  );
  const waiting = boardOrder(s.open.filter((t) => t.status === 'pending'));
  const quote = (t: AgentTasksTask) => quoteTask(t, own);
  const parts = [
    `agent-tasks pipeline (shared by every session): ${working.length} in progress${working.length ? `: ${working.slice(0, 5).map(quote).join('; ')}${working.length > 5 ? `; +${working.length - 5} more` : ''}` : ''}.`,
    `${waiting.length} pending${waiting.length ? `, highest priority first: ${waiting.slice(0, 3).map(quote).join('; ')}` : ''}.`,
    isEnforced
      ? 'Claim a task (task_stage action "claim") before working on it.'
      : 'A task is claimed with task_stage action "claim".',
    'The person follows the board in /pipeline.',
  ];
  return parts.join(' ');
}

const named = (t: AgentTasksTask) => `#${t.id} ${clip(t.title, 40)}`;

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

/** Where the ring was when the server went away: back up, it goes there again if drawn. */
let beforeDown: string | null = null;

/**
 * The board (or task) back after the server was away: the ring returns where it was, else
 * lands as on a fresh open. Refresh is drawn anew as the server comes back, and the ring kept
 * by its place would otherwise sit on a tab.
 */
async function landBack($: EngineInterface) {
  const since = claims;
  const was = beforeDown;
  beforeDown = null;
  if (!(await afterDraw($, since))) return;
  if (!(was && (await focusOn($, was, since)))) await landNow($, null, since);
}

/** Polls by number: one that answers after a later one was drawn is dropped, not drawn over it. */
let polls = 0;
let drawnPoll = 0;

/**
 * What the pane shows, by number: bumped when a poll puts a new board or task in state, and
 * the number the latest drawing read (`drawnVersion`), so a move of the ring can wait for the
 * drawing that shows it.
 */
let version = 0;
let drawnVersion = 0;
const DRAW_WAIT_MS = 1_000;

/**
 * Polls the board and draws it. Quiet, or while an action of the pane is in flight (`busy`,
 * held by `act` until its own poll is drawn), nothing is toasted: what changed is the pane's own.
 * Going down puts the ring on Refresh; coming back up leaves it there (Enter on it is harmless)
 * and drops what a Refresh while down said.
 */
async function refresh($: EngineInterface, quiet = false, isHeld = false) {
  const n = ++polls;
  const next = await poll($);
  const prev = await read($, snapshot);
  if (n < drawnPoll) return prev ?? next;
  drawnPoll = n;
  const write = async () => {
    // Only a poll that changes the controls opens the press guard: an unchanged one every 5 s
    // would take the person's presses at random.
    const isNew = (await drawnState($)) !== (await drawnState($, { snap: next }));
    await update($, snapshot, () => next);
    version += 1;
    if (isNew) await viewChanged($);
    await showStatus($);
  };
  const isWritten =
    isHeld && prev?.isUp && next.isUp
      ? await commit($, { snap: next }, write)
      : (await write(), true);
  // Held back while the person types: the next poll draws it, and toasts it then.
  if (!isWritten) return prev ?? next;
  if (prev?.isUp && !next.isUp) {
    beforeDown = await read($, focused);
    void landNow($);
  }
  if (prev && !prev.isUp && next.isUp) {
    await say($, null);
    void landBack($);
  }
  if (!quiet && prev?.isUp && next.isUp && !(await read($, busy))) {
    const said = changes(prev, next);
    // With the pane closed, the toast says where to look.
    const isShown = (await $.ui.panes()).some((p) => p.id === PANE && p.isPlaced);
    if (said) $.ui.toast(isShown ? said : `${said} (/pipeline)`);
  }

  return next;
}

async function fetchDetail($: EngineInterface, id: number): Promise<AgentTasksDetail> {
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
    gate: gateOf(t.gate_needs),
    links: list(deps.links).map((l) => ({
      ...ref((l.task ?? {}) as Json, blocked),
      relationship: String(l.relationship ?? ''),
    })),
    subtasks: list(t.subtasks).map((x) => ref(x, blocked)),
    subtree: {
      open: list((t.subtree as Json | undefined)?.open).map(Number),
      finished: Number((t.subtree as Json | undefined)?.finished ?? 0),
    },
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
  return next;
}

/**
 * Reloads the open detail; a task deleted elsewhere (or never made) returns to the list. With
 * no board up there is no detail to load: the 404 of a server from before the board is not
 * the task's. A poll (`how`) says the task went elsewhere as a warning, and a poll of a pane
 * holding the keys writes through `commit`.
 */
async function loadView($: EngineInterface, how: 'open' | 'poll' | 'held' = 'open') {
  const r = await read($, route);
  if (r.task === null || !(await read($, snapshot))?.isUp) return;
  const since = claims;
  try {
    const next = await fetchDetail($, r.task);
    const write = async () => {
      const isNew = (await drawnState($)) !== (await drawnState($, { detail: next }));
      await update($, detail, () => next);
      version += 1;
      if (isNew) await viewChanged($);
      await closeStaleForm($);
    };
    if (how === 'held') await commit($, { detail: next }, write);
    else await write();
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
    await update($, route, (x) => ({ ...x, task: null, trail: [] }));
    await say(
      $,
      how === 'open' ? `✗ there is no task #${r.task}` : `! #${r.task} was deleted elsewhere`,
    );
    void land($, null, since);
  }
}

const NOTICE_MS = 10_000;
/** Notices by number: only the one still shown when its time is up is taken away. */
let notices = 0;

/**
 * The status entry: while the server answers, the outcome of the pane's last act while it
 * shows, else the board's headline; while it does not, that it is offline. The outcome is
 * drawn under the tabs too, but a long detail scrolls that out of view; under the prompt it
 * is always in sight.
 */
async function showStatus($: EngineInterface) {
  const said = await read($, notice);
  const snap = await read($, snapshot);
  if (!snap) return;
  $.ui.status(
    !snap.isUp
      ? snap.old
        ? `old server ${snap.old} on the port`
        : 'offline'
      : (said ?? headline(snap.open)),
  );
}

/** Puts an outcome under the tabs and in the status entry, or takes it away; it goes by itself after NOTICE_MS. */
async function say($: EngineInterface, said: string | null) {
  const n = ++notices;
  await update($, notice, () => said);
  await showStatus($);
  if (said)
    void $.clock
      .sleep(NOTICE_MS)
      .then(async () => (n === notices ? say($, null) : undefined))
      .catch(() => undefined);
}

/**
 * Runs one action with its busy line and outcome, then reloads and lands the focus: on `to`'s
 * key when it names one (told whether the action went through), else where `landing` says.
 * The busy line stays until the reload is drawn: a poll answering meanwhile does not toast it.
 * The outcome leads with its mark: ✓ done, – a task dropped (cancelled, marked failed), ✗ refused.
 */
async function act(
  $: EngineInterface,
  label: string,
  fn: () => Promise<string>,
  to?: (ok: boolean) => Promise<string | null>,
  shown?: () => Promise<string | null>,
) {
  const since = claims;
  await update($, busy, () => label);
  await say($, null);
  let ok = true;
  try {
    await say($, (await fn()) || null);
  } catch (err) {
    ok = false;
    await say($, refusal(label, err instanceof Error ? err.message : String(err)));
  }
  const snap = await refresh($, true);
  // Refresh pressed while still down: say it was tried, and when.
  if (!snap.isUp && !(await read($, notice)))
    await say(
      $,
      `✗ still nothing answers at ${snap.origin} (${new Date().toTimeString().slice(0, 8)})`,
    );
  await loadView($).catch(() => {});
  await viewChanged($);
  await update($, busy, () => null);
  // A task this session held may be finished now: what it holds is asked again.
  if (ok) held = hold($);
  const key = to ? await to(ok) : null;
  if (await afterDraw($, since)) {
    if (!(key && (await focusOn($, key, since)))) await landNow($, null, since);
  }
  // What the act made, scrolled into view once drawn and after the ring moved: a ring landing
  // above a long task (its way back) would otherwise scroll it out of sight again.
  const row = shown && ok ? await shown() : null;
  if (row) {
    await drawingOf($, version);
    await $.ui.scroll({ in: PANE, to: { key: row } }).catch(() => undefined);
  }
}

/**
 * A refusal as the person reads it: a task that moved elsewhere is no failure of theirs, and
 * the server's advice to agents (which `task_stage` action to use) is left out.
 */
function refusal(label: string, message: string): string {
  const moved = /^Task (\d+) moved to (\S+) meanwhile/.exec(message);
  if (moved) return `! #${moved[1]} moved elsewhere (now ${moved[2]}): nothing was done`;
  const said = message
    .replace(/\s*Use task_stage[^.]*\.?/g, '')
    .replace(/\s*\(?use task_stage[^.)]*\)?\.?/gi, '')
    .trim();
  return `✗ ${label} failed: ${said}`;
}

/** Where the focus ring lands: the control the person most likely wants next. */
async function landing($: EngineInterface, from: number | null): Promise<string | null> {
  const snap = await read($, snapshot);
  if (!snap?.isUp) return refreshKey(false);
  const r = await read($, route);
  if (r.task !== null) {
    const f = await read($, form);
    if (f?.task === r.task) return f.action === 'regress' && !f.picked ? 'form-stage' : formKey(f);
    const c = await read($, confirm);
    if (c) return 'confirm-no';
    const d = await read($, detail);
    if (!d || d.id !== r.task) return 'back';
    // Never on Advance or Complete: a press meant for something else would move the task. A
    // blocked task's blocker is a link, the place to go.
    const step = nextStep(d);
    return step?.startsWith('dep:') ? step : 'back';
  }
  // The New tab's field takes the ring only when the press asked to type (New task, or the
  // tab pressed again); a tab switch lands on the tab.
  if (r.tab === 'new') return wantsTyping ? `new-title:${await read($, rev)}` : 'tab:new';
  if (r.tab === 'done') {
    const done = await doneShown($);
    const to = from !== null && done.some((t) => t.id === from) ? from : done[0]?.id;
    // Nothing finished yet: the ring stays on the tab it is on, not on another view's.
    return to !== undefined ? `open:${to}` : 'empty-board';
  }
  const query = await read($, filter);
  const shown = boardGroups(
    snap,
    query,
    await read($, expanded),
    (await read($, pinned))?.board ?? null,
  ).flatMap((g) => g.tasks);
  // A fresh board starts on the work in progress, not on the queue above it; a find on its
  // first match.
  const first = (query ? undefined : shown.find((t) => t.status === 'in_progress')) ?? shown[0];
  const to = from !== null && shown.some((t) => t.id === from) ? from : first?.id;
  if (to !== undefined) return `open:${to}`;
  return snap.open.length ? 'clear-filter' : 'empty-new';
}

/**
 * The keys the pane is moving the ring to right now (moves can overlap: one waits for its
 * drawing while another starts). Its own moves and its autoFocus taking the ring both reach
 * `ui.focus` as origin `plugin`; this tells the two apart.
 */
const ownMoves = new Set<string>();

/**
 * Every say over where the ring goes, counted: the person's own moves (Tab, arrows, a click)
 * and every press of the pane. A landing is decided once its view is loaded and drawn, which
 * takes a while; a Tab, or a later press, that came meanwhile wins over it.
 */
let claims = 0;

/**
 * When the controls last changed (`$.clock.now()`). A press on a control that changes a task,
 * or opens a form for it, this soon after went to whatever the new drawing put at the ring's
 * place: the person never saw it (`ui.press` takes it).
 */
let viewChangedAt = -Infinity;
const PRESS_GUARD_MS = 400;

async function viewChanged($: EngineInterface) {
  viewChangedAt = await $.clock.now();
}

/** Controls a stray press must not reach: the risky ones and those that open a task's forms. */
const isGuarded = (key: string) => isRisky(key) || /^(complete:.+|ask:.+|ask-delete)$/.test(key);

/** The ring sits on Refresh, put there by the pane while a view is drawn, not by the person. */
let isParked = false;
/** The ring's key as last moved there (by the pane or the person), for the press trace. */
let focusedKey: string | null = null;

/** Puts the ring on Refresh, above every view, before the controls under it change. */
async function park($: EngineInterface) {
  if (!(await read($, snapshot))?.isUp) return;
  await focusOn($, refreshKey(true, await read($, frame)));
}

/** The tab a `go` asked for, before its route is written: a second press reads it. */
let requested: AgentTasksTab | null = null;

/**
 * Moves the ring and keeps where it went (the header says when the keys go into a text field);
 * false when the key was never drawn, is risky (`isRisky`: the person Tabs there), or a newer
 * claim than `since` (the press or poll that asked for this move) came.
 */
async function focusOn($: EngineInterface, key: string, since?: number): Promise<boolean> {
  if (isRisky(key)) return false;
  if (since !== undefined && since !== claims) return false;
  ownMoves.add(key);
  try {
    const r = await $.ui.focus({ requestId: PANE, key }).catch(() => ({ deny: 'not drawn' }));
    if ('deny' in r) return false;
    isParked = key.startsWith('refresh:');
    focusedKey = key;
    await update($, focused, () => key);
    return true;
  } finally {
    ownMoves.delete(key);
  }
}

/**
 * Whether the control holding the ring is still drawn after a poll changed what the pane
 * shows (a task made, moved or closed elsewhere). The engine keeps the ring at its place in
 * the focus order, so a control that went leaves it on whatever then sits there, a text field
 * included, where the hotkeys would be typed.
 */
async function isGone($: EngineInterface, key: string): Promise<boolean> {
  const snap = await read($, snapshot);
  if (!snap?.isUp) return false;
  if (key.startsWith('refresh:') || key === 'retry')
    return key !== refreshKey(true, await read($, frame));
  const r = await read($, route);
  if (r.task !== null) {
    const d = await read($, detail);
    if (!d || d.id !== r.task) return false;
    const working = d.status === 'in_progress';
    const stages = activeStages(d);
    if (key.startsWith('form')) return !(await read($, form));
    if (key.startsWith('confirm-')) return !(await read($, confirm));
    const [kind, arg] = key.split(':');
    const reachable = working && !isOutOfReach(d.gate);
    if (kind === 'advance') return !reachable || stages[stages.indexOf(d.stage) + 1] !== arg;
    if (kind === 'complete') return !reachable || arg !== d.stage;
    if (key === 'ask:fail') return !working;
    if (key === 'ask:regress' || key === 'ask:cancel') return d.status !== 'pending' && !working;
    if (key === 'reopen') return d.status === 'pending' || working;
    return false;
  }
  if (key === 'empty-new') return r.tab !== 'board' || snap.open.length > 0;
  if (key === 'clear-filter') return !(await read($, filter));
  const id = /^open:(\d+)$/.exec(key)?.[1];
  if (id === undefined) return false;
  const shown =
    r.tab === 'done'
      ? await doneShown($)
      : boardGroups(
          snap,
          await read($, filter),
          await read($, expanded),
          (await read($, pinned))?.board ?? null,
        ).flatMap((g) => g.tasks);
  return !shown.some((t) => t.id === Number(id));
}

/** Done's rows as drawn: the find and the kept order applied. */
async function doneShown($: EngineInterface) {
  const snap = await read($, snapshot);
  const q = await read($, filter);
  return pinOrder(
    snap?.recent.filter((t) => matchesFind(t, q)) ?? [],
    (await read($, pinned))?.done ?? null,
  );
}

/** Waits (at most DRAW_WAIT_MS) until the pane has drawn what was in state at `v`. */
async function drawingOf($: EngineInterface, v: number) {
  for (let waited = 0; drawnVersion < v && waited < DRAW_WAIT_MS; waited += 50)
    await $.clock.sleep(50);
}

/** The order the board and Done are drawn in now (task ids), to keep while the pane is held. */
async function drawnOrder($: EngineInterface): Promise<AgentTasksPinned> {
  const snap = await read($, snapshot);
  if (!snap) return { board: [], done: [] };
  const board = boardGroups(snap, await read($, filter), await read($, expanded), null).flatMap(
    (g) => g.tasks,
  );
  return { board: board.map((t) => t.id), done: snap.recent.map((t) => t.id) };
}

/**
 * What a poll can change under the ring: the rows, their order and the task shown, as drawn
 * now or with `over` in place.
 */
async function drawnState(
  $: EngineInterface,
  over: { snap?: AgentTasksSnapshot; detail?: AgentTasksDetail } = {},
): Promise<string> {
  const snap = over.snap ?? (await read($, snapshot));
  const d = over.detail ?? (await read($, detail));
  // A task's controls are its own; the board's rows matter only where they are drawn.
  if ((await read($, route)).task !== null)
    return JSON.stringify(
      d && [d.id, d.stage, d.status, d.gate, d.artifacts.length, d.comments.length, d.blockers],
    );
  return JSON.stringify([
    snap?.open.map((t) => [t.id, t.stage, t.status, t.priority, t.blocked_by]),
    snap?.recent.map((t) => t.id),
  ]);
}

/** Words typed into a form that closed because its task changed elsewhere: offered back. */
let unsent: { task: number; action: AgentTasksForm['action']; words: string } | null = null;
/** Where the ring goes once a stale form closed: the button that opened it, while drawn. */
let afterStale: string | null = null;

/**
 * An open action form whose task changed elsewhere so that the action no longer applies (it
 * was completed, moved on, failed) closes, and says so: nothing it would send is sent. What was
 * typed is kept: the same button opens the form with it again.
 */
async function closeStaleForm($: EngineInterface) {
  const f = await read($, form);
  const d = await read($, detail);
  if (!f || !d || d.id !== f.task) return;
  const needs =
    f.action === 'complete' || f.action === 'fail' ? ['in_progress'] : ['pending', 'in_progress'];
  const waits = d.blockers.find((b) => b.status === 'pending' || b.status === 'in_progress');
  const isBlocked = f.action === 'complete' && waits !== undefined;
  if (needs.includes(d.status) && d.stage === f.at && !isBlocked) return;
  // The words are kept only when the button that opens the form is drawn again.
  const isBack = needs.includes(d.status) && !isBlocked;
  const words = isBack ? formTyped.trim() : '';
  unsent = words ? { task: f.task, action: f.action, words } : null;
  afterStale = !isBack
    ? 'back'
    : f.action === 'complete'
      ? completeKey(d.stage)
      : `ask:${f.action}`;
  await update($, form, () => null);
  await say(
    $,
    isBlocked && needs.includes(d.status)
      ? `! #${d.id} now waits for #${waits!.id}: nothing was sent`
      : `! #${d.id} changed elsewhere (now ${needs.includes(d.status) ? d.stage : d.status}): nothing was sent${words ? ', what you typed is kept for the form' : ''}`,
  );
}

/**
 * Waits until the drawing of what was just written is on screen: Refresh's key carries
 * `frame`, which only that drawing has, so focusing it waits for it. The engine keeps the ring
 * at its place in the focus order, so a move made before a drawing that adds or removes
 * controls above it would be shifted by it. False when a newer claim came (the person moved
 * the ring meanwhile) or there is no board to draw.
 */
async function afterDraw($: EngineInterface, since?: number): Promise<boolean> {
  if (!(await read($, snapshot))?.isUp) return since === undefined || since === claims;
  const n = (await read($, frame)) + 1;
  await update($, frame, () => n);
  return focusOn($, refreshKey(true, n), since);
}

/** Lands the ring on the drawing up now, unless a newer claim than `since` came. */
async function landNow($: EngineInterface, from: number | null = null, since?: number) {
  const key = await landing($, from);
  if (key) await focusOn($, key, since);
}

/** Lands the ring where `landing` says, once the drawing of the state just written is up. */
async function land($: EngineInterface, from: number | null = null, since = claims) {
  if (await afterDraw($, since)) return landNow($, from, since);
  // Yielded to a newer press that left the ring where the pane parked it: still lands, once
  // nothing else moved it meanwhile.
  const now = claims;
  void $.clock
    .sleep(PRESS_GUARD_MS)
    .then(async () => (isParked && claims === now ? landNow($, from, now) : undefined))
    .catch(() => undefined);
}

/**
 * Writes state that changes which controls are drawn (a poll's board, a task reloaded) without
 * the ring ever sitting where a control slid in. While the person holds the keys, the ring is
 * parked on Refresh first (Enter there is harmless), then the drawing lands, then the ring
 * goes back onto its key while that is still drawn and safe, else to a fresh safe landing.
 * An action in flight (`busy`) lands the ring itself; a write that changes no control moves
 * nothing.
 */
async function commit(
  $: EngineInterface,
  over: { snap?: AgentTasksSnapshot; detail?: AgentTasksDetail },
  write: () => Promise<void>,
): Promise<boolean> {
  const ring = await read($, focused);
  const isQuiet =
    (await read($, busy)) !== null ||
    ring === null ||
    (await drawnState($)) === (await drawnState($, over));
  if (isQuiet) return write().then(() => true);
  // Typing: nothing above the field moves under the keys, and the ring is not parked (keys
  // would reach the prompt). The change waits for a poll after the typing stopped; the status
  // entry says so meanwhile.
  if (await isTyping($)) {
    $.ui.status('the board changed: shown once you stop typing');
    void drawOnceIdle($);
    return false;
  }
  const since = claims;
  // In a text field the ring stays (keys typed meanwhile would hit hotkeys on Refresh): it is
  // put back on the field once the drawing is up.
  if (isField(ring)) {
    await write();
    await drawingOf($, version);
    if ((await isGone($, ring)) || !(await focusOn($, ring, since))) await reland($, ring, since);
    return true;
  }
  if (!(await focusOn($, refreshKey(true, await read($, frame)), since)))
    return write().then(() => true);
  await write();
  await reland($, ring, since);
  return true;
}

/**
 * After a write that changed the controls, with the ring parked on Refresh: back onto `ring`
 * when it is still drawn and safe, onto the button of a form that went stale, else a fresh
 * safe landing. The person's move meanwhile (a newer claim) stands.
 */
async function reland($: EngineInterface, ring: string, since: number) {
  if (!(await afterDraw($, since))) return;
  const stale = afterStale;
  afterStale = null;
  const inTask = (await read($, route)).task !== null;
  const tries = stale ? [stale, 'back'] : [ring, ...(inTask ? ['back'] : [])];
  for (const key of tries) if (!(await isGone($, key)) && (await focusOn($, key, since))) return;
  await landNow($, null, since);
}

/** Narrows the board to `query` and lands on the first row it shows. */
async function refilter($: EngineInterface, query: string) {
  const since = claims;
  await update($, filter, () => query);
  await update($, pinned, () => null);
  await say($, null);
  await update($, rev, (n) => n + 1);
  await land($, null, since);
}

async function reset($: EngineInterface) {
  await update($, confirm, () => null);
  await update($, form, () => null);
  await say($, null);
}

/** The New tab was opened to type in: its field takes the ring (`landing`). */
let wantsTyping = false;

async function go($: EngineInterface, tab: AgentTasksTab, toType = false) {
  const since = claims;
  // Read before any wait: a second press of the same tab right after the first sees it.
  const asked = requested;
  requested = tab;
  const r = await read($, route);
  const snap = await read($, snapshot);
  // Down, the tabs are drawn but lead nowhere yet: the view stays as it comes back.
  if (!snap?.isUp) {
    requested = asked;
    return say($, `! nothing answers at ${snap?.origin ?? 'the server'} yet`);
  }
  const from = r.task;
  // The New tab pressed while it shows (or was just asked for) asks to type, as New task does.
  const isOnNew = (asked ?? (r.task === null ? r.tab : null)) === 'new';
  wantsTyping = tab === 'new' && (toType || isOnNew);
  await park($);
  if (tab === 'new') await update($, draft, () => typed);
  await update($, route, () => ({ tab, task: null, trail: [] }));
  await viewChanged($);
  await reset($);
  await update($, pinned, () => null);
  await land($, from, since);
}

async function open($: EngineInterface, id: number) {
  const since = claims;
  requested = null;
  const r = await read($, route);
  const trail = r.task !== null && r.task !== id ? [...r.trail, r.task] : r.trail;
  // The ring waits on Refresh, and the task draws loading, never the last one's controls: a
  // second Enter must not press what the task view puts at the row's place.
  await park($);
  if ((await read($, detail))?.id !== id) await update($, detail, () => null);
  await update($, route, () => ({ ...r, task: id, trail }));
  await viewChanged($);
  await reset($);
  // A task's folds start shut; the board's stay as the person left them.
  await update($, expanded, (x) => x.filter((p) => p.startsWith('stage:')));
  await loadView($).catch(async (err: Error) => say($, `✗ ${err.message}`));
  await land($, null, since);
}

async function back($: EngineInterface) {
  const since = claims;
  requested = null;
  const r = await read($, route);
  const prev = r.trail.at(-1);
  await park($);
  if (prev !== undefined) {
    await update($, detail, () => null);
    await update($, route, () => ({ ...r, task: prev, trail: r.trail.slice(0, -1) }));
    await viewChanged($);
    await reset($);
    await loadView($).catch(() => {});
    await land($, null, since);
    return;
  }
  await update($, route, () => ({ ...r, task: null, trail: [] }));
  await viewChanged($);
  await reset($);
  await land($, r.task, since);
}

/**
 * Opens the pane afresh with the keys. An open pane is closed first: taking the keys again
 * would put the ring back on the element it last held (a control the new view draws too,
 * or one like it), not on the view's autoFocus element.
 */
async function openPane($: EngineInterface) {
  await $.ui.close({ id: PANE }).catch(() => undefined);
  // A view the command just set starts at its own landing, not where the last one was left,
  // and sorted afresh.
  await update($, focused, () => null);
  await update($, pinned, () => null);
  return $.ui.open({ id: PANE, title: 'agent-tasks', focus: true, rows: PANE_ROWS });
}

/**
 * What is typed into the fields, kept out of the drawn state: a field the hook draws a value
 * into takes that value over what the person is typing, so a value fed back on each key drops
 * or reorders keys typed fast. `draft` (the New fields) and a form's `seed` are drawn only when
 * a field is made anew: a tab switch, a refusal, Clear, a stale form's words offered back.
 */
let typed: AgentTasksDraft = EMPTY_DRAFT;
let formTyped = '';
/** When the person last typed into a field: a poll then holds back what would move the field. */
let lastKeyAt = 0;
const TYPING_MS = 1_500;

async function keyTyped($: EngineInterface) {
  lastKeyAt = await $.clock.now();
}

async function isTyping($: EngineInterface) {
  return isField(await read($, focused)) && (await $.clock.now()) - lastKeyAt < TYPING_MS;
}

/** A change held back while the person typed is drawn as soon as they stop, not a poll later. */
let isWaitingIdle = false;

async function drawOnceIdle($: EngineInterface) {
  if (isWaitingIdle) return;
  isWaitingIdle = true;
  try {
    while (await isTyping($)) await $.clock.sleep(250);
    await refresh($, false, true);
    await loadView($, 'held').catch(() => {});
  } finally {
    isWaitingIdle = false;
  }
}

/** Creates the task the New tab holds and opens it. */
async function create($: EngineInterface): Promise<string> {
  const d = typed;
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
  typed = EMPTY_DRAFT;
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
  const since = claims;
  if (!typed.title.trim()) return say($, '✗ a title is needed');
  if (priorityOf(typed) !== null) return act($, 'Creating the task', async () => create($));
  // Drawn anew with what was typed, the priority's fault said under it.
  await update($, draft, () => typed);
  await update($, rev, (n) => n + 1);
  await focusOn($, `new-priority:${await read($, rev)}`, since);
}

/** Closes the open form or confirmation and puts the ring back on the button that opened it. */
async function dismiss($: EngineInterface) {
  const since = claims;
  const f = await read($, form);
  const stage = (await read($, detail))?.stage ?? '';
  await update($, form, () => null);
  await update($, confirm, () => null);
  // What the form said ("✗ a reason is needed") goes with it.
  await say($, null);
  await focusOn(
    $,
    !f ? 'ask-delete' : f.action === 'complete' ? completeKey(stage) : `ask:${f.action}`,
    since,
  );
}

/** The first row an unfolded stage shows past the folded ones, if the board draws it. */
async function firstUnfolded($: EngineInterface, stage: string): Promise<number | null> {
  const snap = await read($, snapshot);
  if (!snap) return null;
  const g = boardGroups(
    snap,
    await read($, filter),
    await read($, expanded),
    (await read($, pinned))?.board ?? null,
  ).find((x) => x.stage === stage);
  return g?.tasks[FOLD_ROWS]?.id ?? null;
}

/**
 * Unfolds or folds a part of the detail; the ring stays on its toggle (see `foldKey`). An
 * artifact unfolds below its toggle, often below the window: the pane scrolls to show it.
 */
async function toggle($: EngineInterface, part: string) {
  const since = claims;
  await update($, expanded, (x) => (x.includes(part) ? x.filter((p) => p !== part) : [...x, part]));
  const isOpen = (await read($, expanded)).includes(part);
  // A stage unfolded: the ring goes to the first row it showed, which only the new board draws.
  const shown = isOpen && part.startsWith('stage:') ? await firstUnfolded($, part.slice(6)) : null;
  if (shown !== null && (await focusOn($, `open:${shown}`, since))) return;
  await focusOn($, foldKey(part, isOpen), since);
  if (isOpen && part.startsWith('art:'))
    await $.ui.scroll({ in: PANE, to: { key: `artrow:${part.slice(4)}` } }).catch(() => undefined);
}

/** The actions a key typed into a field calls: they record text, they do not move the ring. */
const KEYS_TYPED = new Set(['type', 'edit', 'typing']);

function actions($: EngineInterface): Actions {
  const pressed = actionsOf($);
  // Every press is a claim over the ring: a landing still on its way from an earlier press or
  // a poll yields to it. A key typed into a field is none: the field clears itself after
  // Enter (an input of ''), which would otherwise cancel the landing of the Enter itself.
  return Object.fromEntries(
    Object.entries(pressed).map(([name, f]) => [
      name,
      KEYS_TYPED.has(name)
        ? f
        : (...args: unknown[]) => {
            claims += 1;
            return (f as (...a: unknown[]) => unknown)(...args);
          },
    ]),
  ) as unknown as Actions;
}

function actionsOf($: EngineInterface): Actions {
  const run = (
    label: string,
    fn: () => Promise<string>,
    to?: (ok: boolean) => Promise<string | null>,
    shown?: () => Promise<string | null>,
  ) => void act($, label, fn, to, shown).catch(() => undefined);
  // A move the stage gate refused: its hint under the actions already says why, so the notice
  // only says it held, and where the comment it wants goes. The ring goes to `stay`: never the
  // comment field (what is typed next would be posted as a comment), never the button that
  // moves the task. A Complete form keeps its words.
  const unlessGated = (stay: string) => async (ok: boolean) => {
    const d = await read($, detail);
    if (ok || !d?.gate || !(await read($, notice))?.includes('Stage gate')) return null;
    await say(
      $,
      `✗ #${d.id} can't leave ${d.stage} yet${d.gate.comment ? ': add the comment below' : ''}`,
    );
    return stay;
  };
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
    const doing = {
      complete: 'Completing',
      fail: 'Failing',
      cancel: 'Cancelling',
      regress: 'Sending back',
    }[action];
    run(
      `${doing} #${id}`,
      async () => {
        await update($, form, (f) => (f ? { ...f, words: said } : f));
        if (action === 'regress') {
          const to = (await read($, form))?.stage;
          if (!to) throw new Error('pick the stage to go back to');
          const t = await stage(id, { action, stage: to, ...(said ? { reason: said } : {}) });
          await update($, form, () => null);
          // Back in a queue stage the task waits to be claimed again: said, not left to guess.
          return `✓ #${id} back to ${to}${t.status === 'pending' ? ', waiting to be claimed' : ''}`;
        }
        await stage(id, action === 'cancel' ? { action, reason: said } : { action, result: said });
        await update($, form, () => null);
        return {
          complete: `✓ #${id} completed`,
          fail: `– #${id} marked failed`,
          cancel: `– #${id} cancelled`,
        }[action];
      },
      // Sent back, it offers Advance again: the ring goes to the way out, not onto undoing it.
      // Refused, the form stays with what was sent drawn back into its field (Enter cleared it),
      // and the ring on the form's button.
      async (ok) => {
        if (ok) return action === 'regress' ? 'back' : null;
        await update($, form, (f) => (f ? { ...f, seed: f.words, drawn: (f.drawn ?? 0) + 1 } : f));
        return (await unlessGated('form-dismiss')(ok)) ?? 'form-dismiss';
      },
    );
  };

  return {
    // The ring stays where it is: a Refresh (r) is no reason to move it, and moving it onto
    // the next step would make r and Enter advance the task.
    refresh: () =>
      run(
        'Refreshing',
        async () => '',
        async () => {
          const key = await read($, focused);
          return key && !isParked && !(await isGone($, key)) ? key : null;
        },
      ),
    go: (tab) => void go($, tab),
    newTask: () => void go($, 'new', true),
    open: (id) => void open($, id),
    back: () => void back($),
    find: (q) => void refilter($, q.trim()),
    clearFilter: () => void refilter($, ''),
    // The stage the button names: a second press before the redraw is refused, not a skip.
    // Moved on, the ring goes to the way out: left on the next Advance, a second Enter would
    // move the task a stage further than meant.
    advance: (id, to) =>
      run(
        `Advancing #${id}`,
        async () => {
          const from = (await read($, detail))?.stage;
          const t = await stage(id, { action: 'advance', stage: to, ...(from ? { from } : {}) });
          return `✓ #${id} moved to ${t.stage}`;
        },
        async (ok) => (ok ? 'back' : unlessGated('back')(ok)),
      ),
    ask: (id, action) =>
      void (async () => {
        const since = claims;
        const d = await read($, detail);
        const idx = d ? d.stages.indexOf(d.stage) : -1;
        // What was typed into this form before its task changed elsewhere comes back.
        const kept = unsent?.task === id && unsent.action === action ? unsent.words : '';
        unsent = null;
        formTyped = kept;
        await update($, confirm, () => null);
        await say($, null);
        await update($, form, () => ({
          action,
          task: id,
          stage: action === 'regress' && d && idx > 0 ? d.stages[idx - 1] : null,
          words: kept,
          ...(kept ? { seed: kept } : {}),
          at: d?.stage ?? '',
        }));
        await land($, null, since);
      })(),
    // The stage picked, the ring moves on to the note.
    pickStage: (s) =>
      void (async () => {
        const since = claims;
        await update($, form, (f) => f && { ...f, stage: s, picked: true });
        const f = await read($, form);
        if (f) await focusOn($, formKey(f), since);
      })(),
    // The button sends what was typed; Enter in Send back's optional Why sends only words, so
    // a hurried Enter after picking the stage sends nothing by itself.
    finish: (id, action, words) =>
      action === 'regress' && words !== undefined && !words.trim()
        ? void say($, '– press Send back to send it without a reason')
        : finish(id, action, words ?? formTyped),
    type: (words) => {
      formTyped = words;
      void keyTyped($);
    },
    dismiss: () => void dismiss($),
    askDelete: (id) =>
      void (async () => {
        const since = claims;
        await update($, form, () => null);
        await update($, confirm, () => `delete:${id}`);
        await land($, null, since);
      })(),
    remove: (id) =>
      run(`Deleting #${id}`, async () => {
        await api($, `/api/tasks/${id}`, 'DELETE');
        // Gone from the board it goes back to before the reload: never drawn there once more.
        await update($, snapshot, (s) =>
          s
            ? {
                ...s,
                open: s.open.filter((x) => x.id !== id),
                recent: s.recent.filter((x) => x.id !== id),
              }
            : s,
        );
        await update($, confirm, () => null);
        const r = await read($, route);
        await update($, route, () => ({ ...r, task: null, trail: [] }));
        await update($, detail, () => null);
        return `✓ #${id} deleted`;
      }),
    reopen: (id) =>
      run(`Reopening #${id}`, async () => {
        const t = await stage(id, { action: 'reopen' });
        // Open again, it is on the board: the way back goes there, not to Done.
        await update($, route, (x) => ({ ...x, tab: 'board' as const, trail: [] }));
        return `✓ #${id} open again in ${t.stage}, unclaimed`;
      }),
    comment: (id, words) => {
      const said = words.trim();
      if (!said) return;
      let sent: number | null = null;
      run(
        `Commenting on #${id}`,
        async () => {
          const c = await api($, `/api/tasks/${id}/comments`, 'POST', {
            content: said,
            agent_id: (await read($, snapshot))?.me,
          });
          sent = typeof c.id === 'number' ? c.id : null;
          return `✓ comment added to #${id}`;
        },
        // A fresh, empty field under a new key, and the ring out of it: what is typed next
        // (another /pipeline) must not become a second comment. It goes to the comments' fold,
        // right above them, where there is one; else to the way back, the comment then
        // scrolled into view.
        async () => {
          await update($, rev, (n) => n + 1);
          const d = await read($, detail);
          return d && d.comments.length > COMMENTS_SHOWN
            ? foldKey('comments', (await read($, expanded)).includes('comments'))
            : 'back';
        },
        async () => (sent === null ? null : `c:${sent}`),
      );
    },
    toggle: (part) => void toggle($, part),
    // A tab typed or pasted into a field is a space: a field holds one value.
    edit: (field, value) => {
      typed = { ...typed, [field]: value.replace(/\t/g, ' ') };
      void keyTyped($);
    },
    // Enter creates from any field: walking the fields with Enter moved the ring after the
    // keypress, so what was typed meanwhile went into the field it was leaving. Tab walks them.
    submitField: (field, value) => {
      typed = { ...typed, [field]: value.replace(/\t/g, ' ') };
      void submit($);
    },
    typing: () => void keyTyped($),
    create: () => void submit($),
    // Emptied, the ring stays on Clear: a digit typed next switches tabs, it is not a title.
    clearDraft: () =>
      void (async () => {
        const since = claims;
        wantsTyping = false;
        typed = EMPTY_DRAFT;
        await update($, draft, () => EMPTY_DRAFT);
        await update($, rev, (n) => n + 1);
        await focusOn($, 'clear-draft', since);
      })(),
  };
}

export const register: Register = (on, options) => {
  let isPolling = false;
  let ticks = 0;
  let lastTick = 0;
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pipeline',
      description: 'The agent-tasks board: tasks by stage, details, advance, comment',
      argumentHint: '[task id or text to find]',
    });
    void refresh($, true).catch(() => undefined);
    held = hold($);
    $.clock.every(TICK_MS, async () => {
      ticks += 1;
      // A tick late by more than two (the machine slept) beats at once: the sessions that
      // woke sweep half a minute later, and must find this one alive.
      const now = await $.clock.now();
      const isLate = lastTick > 0 && now - lastTick > 2 * TICK_MS;
      lastTick = now;
      if (isLate || ticks % BEAT_TICKS === 0) held = hold($);
      const pane = (await $.ui.panes()).find((p) => p.id === PANE);
      const shown = pane?.isPlaced === true;
      if (isPolling || !(shown || ticks % IDLE_TICKS === 0)) return;
      isPolling = true;
      try {
        // Held, the pane keeps the order it was drawn in (pinned before this poll can change
        // it); given back to the prompt, it sorts afresh.
        if (!pane?.isFocused) await update($, pinned, () => null);
        else if (!(await read($, pinned))) {
          const order = await drawnOrder($);
          await update($, pinned, () => order);
        }
        const isHeld = pane?.isFocused === true;
        await refresh($, false, isHeld);
        if (shown && ticks % VIEW_TICKS === 0)
          await loadView($, isHeld ? 'held' : 'poll').catch(() => {});
      } finally {
        isPolling = false;
      }
    });

    return next(e);
  });

  on('command.run', { command: 'pipeline' }, async ($, e) => {
    const since = ++claims;
    const snap = await refresh($, true);
    // The transcript gets a line only when something went wrong: no board, no such task, a
    // find that matches nothing, no pane to show it. A plugin command's text also goes to the
    // model, every time, and an open pane says the rest.
    const lines: string[] = [];
    if (!snap.isUp)
      lines.push(
        snap.old
          ? `version ${snap.old} holds ${snap.origin} and has no board: end the sessions still running it`
          : `nothing answers at ${snap.origin}: is the agent-tasks MCP server connected (/mcp)?`,
      );
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
      if (arg && !snap.open.some((t) => matches(t, arg)))
        lines.push(`no open task matches "${arg}"`);
    }
    const opened = await openPane($);
    if (!opened.isPlaced) {
      if (snap.isUp) lines.unshift(headline(snap.open));
      lines.push(`pane not shown: ${opened.reason}`);
    }
    // The take can land on a drawing from before the find; the board's own landing follows it.
    else if (snap.isUp && !isId) await land($, null, since);

    return lines.length ? { text: lines.join('\n') } : {};
  });

  // Where the person moves the ring (Tab, a click): the header says when keys go into a field.
  // The pane taking the keyboard back (ctrl+x tab) puts the ring where it was, while drawn;
  // its autoFocus element is only where a fresh view starts.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const last = await read($, focused);
    if (
      e.origin.kind === 'plugin' &&
      !ownMoves.has(e.element ?? '') &&
      last &&
      last !== e.element
    ) {
      const back = await next({ ...e, element: last });
      if (!('deny' in back)) return back;
    }
    if (e.origin.kind !== 'plugin') {
      claims += 1;
      isParked = false;
      focusedKey = e.element ?? null;
    }
    const r = await next(e);
    if (!('deny' in r)) await update($, focused, () => e.element ?? null);
    return r;
  });

  // A press on a control that changes a task, or opens a form for it, right after the controls
  // changed went to whatever the new drawing put at the ring's place: taken, and said. While
  // an action runs, such a press waits for it.
  on('ui.press', { requestId: PANE }, async ($, e, next) => {
    const key = e.element ?? '';
    const sinceChange = (await $.clock.now()) - viewChangedAt;
    const running = await read($, busy);
    // Every press, in the debug log (--debug-file): what it reached and what came of it.
    const trace = (outcome: string) =>
      $.ui.log(
        `agent-tasks press ${key}: ${outcome} (${Math.round(sinceChange)} ms since the controls changed${isParked ? ', ring parked' : ''}${running ? `, busy ${running}` : ''}, ring ${focusedKey ?? 'none'})`,
        { to: 'debug' },
      );
    if (isGuarded(key) && sinceChange < PRESS_GUARD_MS) {
      trace('taken by the guard');
      await say($, '– that press came as the view changed: nothing was done, press it again');
      return { element: e.element };
    }
    if (running && isGuarded(key)) {
      trace('taken while busy');
      await say($, `– ${running} is still running: press it again when it is done`);
      return { element: e.element };
    }
    try {
      const r = await next(e);
      trace(`handled ${JSON.stringify(r)}`);
      return r;
    } catch (err) {
      // The key reached the drawing before the one now up: its button's handler went with it.
      // A move between views is done anyway; any other press is said, never silently lost.
      trace(`its handler was gone: ${err instanceof Error ? err.message : String(err)}`);
      const tab = /^tab:(board|done|new)$/.exec(key)?.[1] as AgentTasksTab | undefined;
      const row = /^open:(\d+)$/.exec(key)?.[1];
      const fold = /^(.+):(open|shut)$/.exec(key)?.[1];
      const redo = actions($);
      if (tab) redo.go(tab);
      else if (row) redo.open(Number(row));
      else if (fold) redo.toggle(fold);
      else if (key === 'back') redo.back();
      else if (key.startsWith('refresh:')) redo.refresh();
      else await say($, '– that button was drawn again as you pressed it: press it again');
      return { element: e.element };
    }
  });

  // A field or a picker can be drawn anew under a key as well: its handler gone, the engine
  // throws. A stage picked is picked anyway; Enter in a field says nothing was sent (keys
  // typed into a field drawn away are not the pane's to recover); a keystroke stays quiet.
  on('ui.select', { requestId: PANE }, async ($, e, next) => {
    try {
      return await next(e);
    } catch (err) {
      $.ui.log(`agent-tasks select ${e.element}: its handler was gone: ${String(err)}`, {
        to: 'debug',
      });
      if (e.element === 'form-stage') actions($).pickStage(e.value);
      else await say($, '– that list was drawn again as you picked: pick it again');
      return { element: e.element, value: e.value };
    }
  });

  on('ui.input', { requestId: PANE }, async ($, e, next) => {
    try {
      return await next(e);
    } catch (err) {
      $.ui.log(`agent-tasks input ${e.element} (${e.kind}): its handler was gone: ${String(err)}`, {
        to: 'debug',
      });
      if (e.kind === 'submit')
        await say($, '– that field was drawn again as you pressed Enter: nothing was sent');
      return { element: e.element, value: e.value };
    }
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e);
    const seen = version;
    const snap = await read($, snapshot);
    if (!snap) return <el.Progress label="The board" valueText="loading…" />;
    // Read together: a drawing that waits on each value in turn leaves the pane blank longer.
    const [r, q, d, ex, c, f, dr, n, fr, b, no, fo, auto, pin, my] = await Promise.all([
      read($, route),
      read($, filter),
      read($, detail),
      read($, expanded),
      read($, confirm),
      read($, form),
      read($, draft),
      read($, rev),
      read($, frame),
      read($, busy),
      read($, notice),
      read($, focused),
      landing($, null),
      read($, pinned),
      read($, mine),
    ]);

    drawnVersion = Math.max(drawnVersion, seen);
    return (
      <Pane
        el={el}
        snap={snap}
        route={r}
        filter={q}
        detail={d}
        expanded={ex}
        confirm={c}
        form={f}
        draft={dr}
        rev={n}
        frame={fr}
        busy={b}
        notice={no}
        focused={fo}
        isFocused={e.props.isFocused}
        columns={e.props.bodyColumns}
        landing={auto}
        pinned={pin}
        mine={my}
        on={actions($)}
      />
    );
  });

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Json;
    const r = await next(e);
    if (!isTaskStage(e.tool) || 'deny' in r || r.isError) return r;
    const { action, task_id: id } = args;
    // Claimed, or moved on: the session working on it holds it.
    if (['claim', 'assign', 'advance', 'regress'].includes(String(action)) && Number.isInteger(id))
      await (held = hold($, [id]));
    // Finished: the session may hold nothing now, and the next prompt is judged on that.
    else if (['complete', 'fail', 'cancel'].includes(String(action))) await (held = hold($));

    return r;
  });

  on('session.end', async ($, e, next) => {
    // A /clear ends the conversation, not the session's work: its claims are carried over.
    if (e.reason === 'clear') clearedFrom = e.sessionId;
    else await api($, holderPath(e.sessionId), 'DELETE').catch(() => {});

    return next(e);
  });

  on('prompt.submit', async ($, e, next) => {
    if (
      options.enforcePipeline !== true ||
      e.command ||
      e.isMeta ||
      !PROMPTED_BY_PERSON.has(e.origin.kind) ||
      !isWorkPrompt(e.text)
    )
      return next(e);
    // What this session holds is known from its beats, with no request of its own. Before the
    // first beat answered, a new conversation (nothing said in it yet, nothing carried over
    // from a /clear) holds nothing by definition; a resumed one has claims only the server
    // knows, so its prompt waits for the beat (a request gives up after FETCH_TIMEOUT_MS), and
    // no answer lets it through without a reminder.
    const isNew = async () => {
      const said = await $.session.messages().catch(() => null);
      return (
        clearedFrom === null && Array.isArray(said) && !said.some((m) => m.role === 'assistant')
      );
    };
    const count = isMineKnown
      ? (await read($, mine)).length
      : (await isNew())
        ? 0
        : (await held)?.length;
    if (count === undefined || count > 0) return next(e);

    return next({ ...e, context: [...(e.context ?? []), PIPELINE_REMINDER] });
  });

  on('prompt.context', async ($, e, next) => {
    const r = await next(e);
    const snap = (await read($, snapshot)) ?? (await refresh($, true));
    if (!snap.isUp) return r;
    const own = new Set(
      isMineKnown
        ? await read($, mine)
        : (
            (await Promise.race([held, $.clock.sleep(REMIND_WITHIN_MS).then(() => null)])) ?? []
          ).map((t) => Number(t.id)),
    );
    const text = contextText(snap, own, options.enforcePipeline === true);

    return { ...r, blocks: [...r.blocks, { name: 'agent-tasks', text }] };
  });
};
