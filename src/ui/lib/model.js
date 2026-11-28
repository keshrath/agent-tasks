// =============================================================================
// The board's data as the dashboard and the widget draw it. Pure functions over
// server JSON (GET /api/board, the task_get shape), read defensively: nothing in
// an answer is trusted for shape. Same rules as the /pipeline pane (plugin/hooks).
// =============================================================================

export const STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'];
export const DEFAULT_STAGES = ['backlog', 'spec', 'plan', 'implement', 'test', 'review', 'done'];

const list = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (typeof v === 'string' && v !== '' ? v : null);
const status = (v) => (STATUSES.includes(v) ? v : 'pending');
export const isOpen = (st) => st === 'pending' || st === 'in_progress';
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Tags arrive as a JSON array string (or an array). */
export function tags(v) {
  if (Array.isArray(v)) return v.map(String);
  try {
    const parsed = JSON.parse(String(v ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Server timestamps are UTC (SQLite's `YYYY-MM-DD HH:MM:SS`, or ISO). */
export function parseTs(ts) {
  const s = String(ts ?? '');
  return new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
}

/** How long ago, short: now, 5m, 3h, 2d. */
export function ago(ts, now = Date.now()) {
  const ms = now - parseTs(ts).getTime();
  if (Number.isNaN(ms)) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** When, in words: just now, 5m ago, 3h ago, 2d ago; past a week the local date. */
export function when(ts, now = Date.now()) {
  const d = parseTs(ts);
  const short = ago(ts, now);
  if (!short) return String(ts ?? '');
  if (short === 'now') return 'just now';
  if (now - d.getTime() < 7 * 86_400_000) return `${short} ago`;
  return d.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** One task as a card draws it. `blockedBy` are the open tasks it waits for. */
export function task(t, blockedBy = [], sub = null) {
  return {
    id: Number(t.id),
    title: String(t.title ?? ''),
    stage: String(t.stage ?? ''),
    status: status(t.status),
    priority: Number(t.priority ?? 0),
    project: text(t.project),
    assigned_to: text(t.assigned_to),
    tags: tags(t.tags),
    parent_id: typeof t.parent_id === 'number' ? t.parent_id : null,
    result: text(t.result),
    closed_from: text(t.closed_from),
    created_at: String(t.created_at ?? ''),
    updated_at: String(t.updated_at ?? ''),
    blocked_by: blockedBy,
    subtasks:
      sub && Number(sub.total) > 0 ? { done: Number(sub.done), total: Number(sub.total) } : null,
  };
}

/** GET /api/board as a snapshot: open tasks with what they wait for, recent closed ones. */
export function snapshot(b) {
  const open = list(b?.open);
  const openIds = new Set(open.map((t) => Number(t.id)));
  const blockers = new Map();
  for (const d of list(b?.dependencies)) {
    if (d.relationship !== 'blocks' || !openIds.has(Number(d.depends_on))) continue;
    const id = Number(d.task_id);
    blockers.set(id, [...(blockers.get(id) ?? []), Number(d.depends_on)]);
  }
  const progress = b?.subtaskProgress ?? {};
  return {
    stages: list(b?.stages).map(String),
    pipelines: Object.fromEntries(
      Object.entries(b?.pipelines ?? {}).map(([p, st]) => [p, list(st).map(String)]),
    ),
    open: open.map((t) => task(t, blockers.get(Number(t.id)) ?? [], progress[t.id])),
    recent: list(b?.recent).map((t) => task(t)),
  };
}

/** A plain task list (task_list) as a snapshot: no dependency data (`noDeps`), so nothing shows blocked. */
export function snapshotOf(tasks, stages = DEFAULT_STAGES) {
  const all = list(tasks).map((t) => task(t));
  return {
    stages,
    pipelines: {},
    noDeps: true,
    open: all.filter((t) => isOpen(t.status)),
    recent: all
      .filter((t) => !isOpen(t.status))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id),
  };
}

const ref = (t, blocked) => ({
  id: Number(t?.id),
  title: String(t?.title ?? ''),
  stage: String(t?.stage ?? ''),
  status: status(t?.status),
  isBlocked: blocked.has(Number(t?.id)),
});

function gateOf(v) {
  if (!v || typeof v !== 'object') return null;
  return {
    comment: Boolean(v.comment),
    artifact: Boolean(v.artifact),
    artifacts: list(v.artifacts).map(String),
    more: Number(v.min_artifacts ?? 0),
    approval: Boolean(v.approval),
  };
}

/** The task_get shape (with subtasks and comments) as the detail draws it. */
export function detail(t, stages, snap = null, parent = null) {
  const blocked = new Set((snap?.open ?? []).filter((x) => x.blocked_by.length).map((x) => x.id));
  const deps = t.dependencies ?? {};
  const artifacts = list(t.artifacts);
  return {
    ...task(t),
    description: String(t.description ?? ''),
    created_by: String(t.created_by ?? ''),
    stages: list(stages).map(String),
    parent: parent ? ref(parent, blocked) : null,
    blockers: list(deps.blockers).map((x) => ref(x, blocked)),
    blocking: list(deps.blocking).map((x) => ref(x, blocked)),
    links: list(deps.links).map((l) => ({
      ...ref(l.task, blocked),
      relationship: String(l.relationship ?? ''),
    })),
    gate: gateOf(t.gate_needs),
    subtasks: list(t.subtasks).map((x) => ref(x, blocked)),
    subtree: {
      open: list(t.subtree?.open).map(Number),
      finished: Number(t.subtree?.finished ?? 0),
    },
    artifacts: artifacts
      .filter(
        (a, i) => !artifacts.some((b, j) => j > i && b.name === a.name && b.stage === a.stage),
      )
      .reverse()
      .map((a) => ({
        id: Number(a.id),
        stage: String(a.stage ?? ''),
        name: String(a.name ?? ''),
        version: Number(a.version ?? 1),
        created_by: String(a.created_by ?? ''),
        created_at: String(a.created_at ?? ''),
        content: String(a.content ?? ''),
      })),
    commentCount: Number(t.comments_count ?? 0),
    comments: list(t.comments).map((c) => ({
      id: Number(c.id),
      author: String(c.agent_id ?? ''),
      content: String(c.content ?? ''),
      created_at: String(c.created_at ?? ''),
    })),
  };
}

/** The board's counts: open, in progress, blocked. */
export function tally(open) {
  return {
    open: open.length,
    working: open.filter((t) => t.status === 'in_progress').length,
    blocked: open.filter((t) => t.blocked_by.length > 0).length,
  };
}

/** Every stage the board has a column for, in pipeline order: the default, then custom ones. */
export function stageOrder(snap) {
  const out = [...snap.stages];
  for (const st of Object.values(snap.pipelines))
    for (const x of st) if (!out.includes(x)) out.push(x);
  return out.filter((x) => x !== 'cancelled');
}

const byWork = (a, b) =>
  Number(b.status === 'in_progress') - Number(a.status === 'in_progress') ||
  b.priority - a.priority ||
  a.id - b.id;

/** The find: `#12` is that task; other text is found in the id, title, assignee, project or tags. */
export function matches(t, query) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!q) return true;
  if (/^#\d+$/.test(q)) return t.id === Number(q.slice(1));
  return [String(t.id), t.title, t.assigned_to ?? '', t.project ?? '', ...t.tags].some((v) =>
    v.toLowerCase().includes(q),
  );
}

/** The project and assignee pickers ('' any, 'unclaimed' for nobody). */
export function picked(t, facets) {
  return (
    (!facets.project || t.project === facets.project) &&
    (!facets.assignee || (t.assigned_to ?? 'unclaimed') === facets.assignee)
  );
}

/** What the pickers offer: every project and assignee the board knows. */
export function facetsOf(snap) {
  const all = [...snap.open, ...snap.recent];
  return {
    projects: [...new Set(all.map((t) => t.project).filter(Boolean))].sort(),
    assignees: [...new Set(all.map((t) => t.assigned_to ?? 'unclaimed'))].sort(),
  };
}

/** The kanban's columns: every stage with its open tasks that pass the filters, working first. */
export function columns(snap, filter) {
  const shown = snap.open.filter((t) => matches(t, filter.find) && picked(t, filter)).sort(byWork);
  const stages = stageOrder(snap).filter((x) => x !== 'done' || shown.some((t) => t.stage === x));
  const cols = stages.map((stage) => ({ stage, tasks: shown.filter((t) => t.stage === stage) }));
  const stray = shown.filter((t) => !stages.includes(t.stage));
  if (stray.length) cols.push({ stage: 'other', tasks: stray });
  return cols;
}

/** Done: the recently closed that pass the filters, newest first. */
export const finished = (snap, filter) =>
  snap.recent.filter((t) => matches(t, filter.find) && picked(t, filter));

/** The stages a task can still move through (its pipeline without `cancelled`). */
export const activeStages = (d) => d.stages.filter((x) => x !== 'cancelled');

/** A gate only an agent or an approval can pass (artifacts, an approval): not from here. */
export const isOutOfReach = (g) =>
  g !== null && (g.artifact || g.artifacts.length > 0 || g.more > 0 || g.approval);

/** What the stage gate asks for, in words: "a comment and artifact review-notes". */
export function gateText(g) {
  const parts = [
    g.comment && 'a comment',
    g.artifacts.length > 0 &&
      `${g.artifacts.length === 1 ? 'artifact' : 'artifacts'} ${g.artifacts.join(', ')}`,
    g.artifact && 'an artifact',
    g.more > 0 && plural(g.more, 'more artifact'),
    g.approval && 'an approval',
  ].filter((p) => typeof p === 'string');
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
}

/** The gate's line under the actions: what it needs and who gives it. */
export function gateHint(g, stage) {
  const who = [
    g.comment && 'add a comment below',
    (g.artifact || g.artifacts.length > 0 || g.more > 0) && 'an agent attaches artifacts',
    g.approval && 'an approval cannot be given from here',
  ].filter((p) => typeof p === 'string');
  return `Needs ${gateText(g)} before it leaves ${stage}: ${who.join('; ')}.`;
}

/** The state word and tone of a task: blocked, in progress, pending, unclaimed, ... */
export function look(t, blocked = false) {
  if (blocked && isOpen(t.status)) return { word: 'blocked', tone: 'warning' };
  switch (t.status) {
    case 'in_progress':
      return { word: 'in progress', tone: 'info' };
    case 'completed':
      return { word: 'completed', tone: 'success' };
    case 'failed':
      return { word: 'failed', tone: 'danger' };
    case 'cancelled':
      return { word: 'cancelled', tone: 'muted' };
    default:
      return { word: t.assigned_to ? 'pending' : 'unclaimed', tone: 'muted' };
  }
}

/**
 * What a person can do with the task from here, as the pane allows it: Advance and Complete
 * only for a task in progress that nothing blocks and no out-of-reach gate holds.
 */
export function actionsFor(d) {
  const waiting = d.blockers.filter((b) => isOpen(b.status));
  const stages = activeStages(d);
  const idx = stages.indexOf(d.stage);
  const isLive = isOpen(d.status);
  const isWorking = d.status === 'in_progress';
  const reachable = waiting.length === 0 && !isOutOfReach(d.gate);
  const atEnd = idx >= stages.length - 2;
  return {
    waiting,
    advance: isWorking && reachable && !atEnd && idx >= 0 ? stages[idx + 1] : null,
    complete: isWorking && reachable,
    primary: isWorking && reachable && !d.gate ? (atEnd ? 'complete' : 'advance') : null,
    regress: isLive && idx > 0 ? stages.slice(0, idx) : [],
    fail: isWorking,
    cancel: isLive,
    reopen: !isLive,
    remove: true,
  };
}

/** Tasks finished on each of the last `days` days, per outcome. */
export function throughput(recent, days = 7, now = new Date()) {
  const key = (d) => (Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA'));
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(now.getTime() - (days - 1 - i) * 86_400_000);
    const on = recent.filter((t) => key(parseTs(t.updated_at)) === key(d));
    return {
      label: d.toLocaleDateString('en', { weekday: 'short' }),
      done: on.filter((t) => t.status === 'completed').length,
      failed: on.filter((t) => t.status !== 'completed').length,
    };
  });
}

/** Open tasks per stage: in progress and waiting. */
export function perStage(snap) {
  return stageOrder(snap)
    .filter((x) => x !== 'done' || snap.open.some((t) => t.stage === x))
    .map((stage) => {
      const here = snap.open.filter((t) => t.stage === stage);
      const working = here.filter((t) => t.status === 'in_progress').length;
      return { stage, working, waiting: here.length - working };
    });
}

/** Open tasks per key (project, assignee), most first. */
export function breakdown(open, keyOf) {
  const counts = new Map();
  for (const t of open) counts.set(keyOf(t), (counts.get(keyOf(t)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
