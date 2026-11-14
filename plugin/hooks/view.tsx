// Trees for the /pipeline pane. Pure: state in, elements out; the actions come from
// register.tsx. Laid out for the docked sidebar first (about 38 to 70 columns): a
// one-line tab bar, one status line, two-line rows, labels beside wrapping values,
// summary lines that break between their parts. Wider panes only get more room.
import type { Elements } from 'claude-code';

import type {
  AgentTasksDetail,
  AgentTasksDraft,
  AgentTasksForm,
  AgentTasksGate,
  AgentTasksPinned,
  AgentTasksRef,
  AgentTasksRoute,
  AgentTasksSnapshot,
  AgentTasksStatus,
  AgentTasksTab,
  AgentTasksTask,
} from '../types';

/** The elements the pane draws with; mobile has no `Input` or `Select`. */
export type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Markdown' | 'Progress'> &
  Partial<Pick<Elements['terminal'], 'Input' | 'Select'>>;

export type Actions = {
  refresh: () => void;
  go: (tab: AgentTasksTab) => void;
  /** Opens the New tab to type in (a press that asked for it: New task). */
  newTask: () => void;
  open: (id: number) => void;
  back: () => void;
  find: (query: string) => void;
  clearFilter: () => void;
  /** Moves the task on to `stage`, the one the button names. */
  advance: (id: number, stage: string) => void;
  /** Opens the field an action needs its words in. */
  ask: (id: number, action: AgentTasksForm['action']) => void;
  pickStage: (stage: string) => void;
  /** Sends the open form: `words` from its field's Enter, else what was typed into it. */
  finish: (id: number, action: AgentTasksForm['action'], words?: string) => void;
  /** Keeps what is typed in the open form's field, for its button. */
  type: (words: string) => void;
  /** A key typed into a field that keeps no text in state (Find, the comment). */
  typing: () => void;
  /** Closes the open form or confirmation. */
  dismiss: () => void;
  askDelete: (id: number) => void;
  remove: (id: number) => void;
  /** A failed, completed or cancelled task open again, unclaimed. */
  reopen: (id: number) => void;
  comment: (id: number, words: string) => void;
  /** Unfolds or folds a part of the detail (`foldKey`). */
  toggle: (part: string) => void;
  edit: (field: keyof AgentTasksDraft, value: string) => void;
  /** Enter in a New field: keeps its text and creates the task (Tab walks the fields). */
  submitField: (field: keyof AgentTasksDraft, value: string) => void;
  create: () => void;
  clearDraft: () => void;
};

// Theme keys, so the pane follows the person's theme (light, dark, colorblind).
const OK = 'success';
const BAD = 'error';
const WARN = 'warning';
const ACCENT = 'suggestion';

/** Optional props are left out, never passed as undefined: a remote surface refuses undefined. */
const color = (c: string | false | undefined) => (c ? { color: c } : {});
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pad2 = (n: number) => String(n).padStart(2, '0');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Terminal columns of one code point: wide East Asian and emoji take two, marks none. */
function charCols(ch: string): number {
  const c = ch.codePointAt(0)!;
  if ((c >= 0x200b && c <= 0x200f) || (c >= 0xfe00 && c <= 0xfe0f) || /\p{M}/u.test(ch)) return 0;
  if (/\p{Emoji_Presentation}/u.test(ch)) return 2;
  return (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x20000 && c <= 0x3fffd)
    ? 2
    : 1;
}

/** Display width in terminal columns, which is what wraps a line; `length` counts UTF-16 units. */
export const cols = (s: string) => [...s].reduce((n, ch) => n + charCols(ch), 0);

/**
 * Whole facts, in order, as many as fit `width` columns joined by ` · `: a fact cut in half
 * (`agent-tas…`) or a separator left dangling says less than one left out.
 */
export function fitFacts(facts: (Part | false | null | undefined)[], width: number): Part[] {
  const shown: Part[] = [];
  let used = 0;
  for (const f of facts) {
    if (!f) continue;
    const w = cols(typeof f === 'string' ? f : f.text) + (shown.length ? 3 : 0);
    if (used + w > width) break;
    shown.push(f);
    used += w;
  }
  return shown;
}

/** What a terminal escape sequence looks like: OSC (to BEL or ST), CSI, or a two-key escape. */
const ESCAPES =
  // eslint-disable-next-line no-control-regex
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
/** Control characters a drawn text may not hold: C0 but newline and tab, DEL, C1. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Text as the pane can draw it. Agents write tasks, comments and artifacts from tool output,
 * colour codes and all; one control character in a drawn text makes Claude Code refuse the
 * whole pane. Escape sequences go whole, line ends become newlines, any other control
 * character a visible `�`.
 */
export const printable = (s: string) =>
  s.replace(ESCAPES, '').replace(/\r\n?/g, '\n').replace(CONTROLS, '\uFFFD');

/** `s` cut to `n` columns with an ellipsis. */
export function clip(s: string, n: number): string {
  if (cols(s) <= n) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const w = charCols(ch);
    if (used + w > Math.max(1, n - 1)) break;
    out += ch;
    used += w;
  }
  return `${out.trimEnd()}…`;
}
/**
 * A text whose Markdown tables fit `width`: a table wider than the pane reads one row a line,
 * its cells joined with ` · ` (the header bold), as box drawing past the edge cannot be read.
 * The same reading as agent-knowledge's /knowledge pane.
 */
export function fitTables(body: string, width: number): string {
  const lines = body.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!/^\s*\|/.test(lines[i]!)) {
      out.push(lines[i++]!);
      continue;
    }
    const table: string[] = [];
    while (i < lines.length && /^\s*\|/.test(lines[i]!)) table.push(lines[i++]!.trim());
    const cells = (row: string) =>
      row
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
    const rows = table.filter((r) => !/^\|?[\s:|-]+\|?$/.test(r)).map(cells);
    const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => cols(r[c] ?? '')))) ?? [];
    const drawn = widths.reduce((sum, w) => sum + w + 3, 1);
    if (drawn <= width) {
      out.push(...table);
      continue;
    }
    rows.forEach((r, n) => out.push(n === 0 ? `**${r.join(' · ')}**` : r.join(' · '), ''));
  }
  return out.join('\n');
}

/** A result's first line, `…` after it when more follows, so a cut never reads as whole. */
const firstLine = (s: string) => {
  const lines = s.split('\n').filter((l) => l.trim());
  return `${lines[0]?.trim() ?? ''}${lines.length > 1 ? ' …' : ''}`;
};

/** Server timestamps are UTC (SQLite's `YYYY-MM-DD HH:MM:SS`, or ISO). */
function parse(ts: string): Date {
  return new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts.replace(' ', 'T')}Z`);
}

/** Local time: HH:MM today, YYYY-MM-DD HH:MM before. */
export function time(ts: string, now = new Date()): string {
  const d = parse(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toDateString() === now.toDateString()
    ? clock
    : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
}

/** When, in the detail: just now, 5m ago, 3h ago, 2d ago; past a week the local date and time. */
export function when(ts: string, now = new Date()): string {
  const ms = now.getTime() - parse(ts).getTime();
  if (Number.isNaN(ms)) return ts;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h ago`;
  if (min < 7 * 24 * 60) return `${Math.floor(min / (24 * 60))}d ago`;
  return time(ts, now);
}

/** How long ago, for a row's facts: now, 5m, 3h, 2d. */
export function ago(ts: string, now = Date.now()): string {
  const ms = now - parse(ts).getTime();
  if (Number.isNaN(ms)) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export const isOpen = (s: AgentTasksStatus) => s === 'pending' || s === 'in_progress';

/** The board's counts: open, in progress, blocked. */
export function tally(open: AgentTasksTask[]) {
  return {
    open: open.length,
    working: open.filter((t) => t.status === 'in_progress').length,
    blocked: open.filter((t) => t.blocked_by.length > 0).length,
  };
}

/** What the stage gate asks for, in words: "a comment and artifact review-notes". */
export function gateText(g: AgentTasksGate): string {
  const parts = [
    g.comment && 'a comment',
    g.artifacts.length > 0 &&
      `${g.artifacts.length === 1 ? 'artifact' : 'artifacts'} ${g.artifacts.join(', ')}`,
    g.artifact && 'an artifact',
    g.more > 0 && plural(g.more, 'more artifact'),
    g.approval && 'an approval',
  ].filter((p): p is string => typeof p === 'string');
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]!;
}

/**
 * The gate's line under the actions: what it needs and who gives it. A comment is added in the
 * field below; artifacts come from an agent; no tool records an approval.
 */
/** What the delete box asks, or why there is nothing to delete yet. */
export function deleteQuestion(d: Pick<AgentTasksDetail, 'id' | 'subtree'>): string {
  const { open, finished } = d.subtree;
  if (open.length)
    return `#${d.id} has open subtasks (${open.map((id) => `#${id}`).join(', ')}): finish, cancel or delete them first.`;
  const along = ['artifacts', 'comments', finished ? plural(finished, 'finished subtask') : '']
    .filter(Boolean)
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1');
  return `Delete #${d.id} with its ${along}? There is no undo.`;
}

export function gateHint(g: AgentTasksGate, stage: string): string {
  const who = [
    g.comment && 'add the comment below',
    (g.artifact || g.artifacts.length > 0 || g.more > 0) && 'an agent attaches artifacts',
    g.approval && 'an approval cannot be given from here',
  ].filter((p): p is string => typeof p === 'string');
  return `Needs ${gateText(g)} before it leaves ${stage}: ${who.join('; ')}.`;
}

/** The board's summary line as text: the status line entry reads the same. */
export function headline(open: AgentTasksTask[]): string {
  const n = tally(open);
  return [
    plural(n.open, 'open task'),
    `${n.working} in progress`,
    n.blocked ? `${n.blocked} blocked` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const needle = (query: string) => query.toLowerCase().replace(/^#/, '');

/** The board filter: text found in the id, title, assignee, project or tags. */
export function matches(t: AgentTasksTask, query: string): boolean {
  const q = needle(query);
  if (!q) return true;
  return [String(t.id), t.title, t.assigned_to ?? '', t.project ?? '', ...t.tags].some((v) =>
    v.toLowerCase().includes(q),
  );
}

/** The tags the filter is found in: a row draws them, tags being nowhere else on it. */
const tagsFound = (t: AgentTasksTask, query: string) =>
  needle(query) ? t.tags.filter((tag) => tag.toLowerCase().includes(needle(query))) : [];

/** Every stage the board has a section for, in pipeline order: the default, then custom ones. */
export function stageOrder(snap: Pick<AgentTasksSnapshot, 'stages' | 'pipelines'>): string[] {
  const out = [...snap.stages];
  for (const stages of Object.values(snap.pipelines))
    for (const s of stages) if (!out.includes(s)) out.push(s);
  return out.filter((s) => s !== 'cancelled');
}

const byWork = (a: AgentTasksTask, b: AgentTasksTask) =>
  Number(b.status === 'in_progress') - Number(a.status === 'in_progress') ||
  b.priority - a.priority ||
  a.id - b.id;

/** Tasks as the board draws them: by stage (with `snap`), working first, then by priority. */
export function boardOrder(
  tasks: AgentTasksTask[],
  snap?: Pick<AgentTasksSnapshot, 'stages' | 'pipelines'>,
): AgentTasksTask[] {
  if (!snap) return [...tasks].sort(byWork);
  const order = stageOrder(snap);
  const at = (s: string) => (order.includes(s) ? order.indexOf(s) : order.length);
  return [...tasks].sort((a, b) => at(a.stage) - at(b.stage) || byWork(a, b));
}

/** Rows a stage nobody works on (a backlog) shows before it folds the rest away. */
export const FOLD_ROWS = 5;

/**
 * The board's groups as drawn: open tasks matching `filter` by stage, and how many rows each
 * folds away. A stage where nothing is in progress (a backlog) folds past FOLD_ROWS, so a long
 * queue never buries the work in flight below it; a find shows every match.
 */
/**
 * `tasks` in the order `pinned` drew them, the ones it does not hold after, as they came: a
 * poll then never moves a row under the ring while the pane holds the keyboard.
 */
export function pinOrder<T extends { id: number }>(tasks: T[], pinned: number[] | null): T[] {
  if (!pinned) return tasks;
  const at = new Map(pinned.map((id, i) => [id, i]));
  const held = tasks.filter((t) => at.has(t.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  return [...held, ...tasks.filter((t) => !at.has(t.id))];
}

export function boardGroups(
  snap: AgentTasksSnapshot,
  filter: string,
  expanded: string[],
  pinned: number[] | null = null,
): { stage: string; tasks: AgentTasksTask[]; hidden: number }[] {
  const shown = boardOrder(
    snap.open.filter((t) => matches(t, filter)),
    snap,
  );
  const stages = stageOrder(snap);
  const groups = stages
    .map((stage) => ({
      stage,
      tasks: pinOrder(
        shown.filter((t) => t.stage === stage),
        pinned,
      ),
    }))
    .filter((g) => g.tasks.length > 0);
  const stray = shown.filter((t) => !stages.includes(t.stage));
  if (stray.length) groups.push({ stage: 'other stages', tasks: stray });
  return groups.map((g) => {
    const folds =
      filter === '' &&
      g.tasks.length > FOLD_ROWS + 2 &&
      g.tasks.every((t) => t.status !== 'in_progress') &&
      !expanded.includes(`stage:${g.stage}`);
    return folds
      ? { ...g, tasks: g.tasks.slice(0, FOLD_ROWS), hidden: g.tasks.length - FOLD_ROWS }
      : { ...g, hidden: 0 };
  });
}

/** The stages a task can still move through (its pipeline without `cancelled`). */
export const activeStages = (d: Pick<AgentTasksDetail, 'stages'>) =>
  d.stages.filter((s) => s !== 'cancelled');

/** Complete's key names the stage it completes from, for the same reason as `advance:<stage>`. */
export const completeKey = (stage: string) => `complete:${stage}`;

/**
 * The key of the action that moves a task on: what the focus lands on in its detail.
 * An unclaimed task has none: agents claim with task_stage, and moving it on from here
 * would leave it in progress with nobody on it.
 */
export function nextStep(d: AgentTasksDetail): string | null {
  if (d.status !== 'in_progress') return null;
  // It cannot move on: the task it waits for is the place to go.
  const waiting = d.blockers.find((b) => isOpen(b.status));
  if (waiting) return `dep:${waiting.id}`;
  const stages = activeStages(d);
  const idx = stages.indexOf(d.stage);
  if (idx < 0) return null;
  // The key names the stage it moves to: a key the tree before the move also drew would
  // take the ring there, and the redraw would leave it on whatever then sits in that place.
  return idx >= stages.length - 2 ? completeKey(d.stage) : `advance:${stages[idx + 1]}`;
}

/**
 * A fold's toggle key names its state: landing on it after a toggle waits for the drawing
 * that shows the new state. The engine keeps the ring at its place in the focus order
 * across a redraw, not on a key, so the toggle lands it again itself.
 */
export const foldKey = (part: string, isOpen: boolean) => `${part}:${isOpen ? 'open' : 'shut'}`;

/**
 * Refresh's key names whether the server is up: the tabs before it come and go with it, which
 * would move a ring kept by its place, so Refresh is drawn anew and lands it itself. Up, it
 * also names `rev`: a button only the board after a bump draws, which a landing waits on.
 */
export const refreshKey = (isUp: boolean, frame = 0) => (isUp ? `refresh:${frame}` : 'retry');

/**
 * Controls one Enter on them changes a task with (Advance, Reopen, a form's or the delete
 * box's send, Create): the ring never lands on them by itself, so a stray Enter after a move,
 * a poll or a command changes nothing. The person Tabs there.
 */
export const isRisky = (key: string) =>
  /^(advance:.+|reopen|confirm-yes|form-submit|create)$/.test(key);

/** A gate only an agent or an approval can pass (artifacts, an approval): not from the pane. */
export const isOutOfReach = (g: AgentTasksGate | null) =>
  g !== null && (g.artifact || g.artifacts.length > 0 || g.more > 0 || g.approval);

type Look = { mark: string; tone: string | undefined; word: string };

function look(t: { status: AgentTasksStatus; assigned_to?: string | null }, blocked = false): Look {
  if (blocked && isOpen(t.status)) return { mark: '!', tone: WARN, word: 'blocked' };
  switch (t.status) {
    case 'in_progress':
      return { mark: '●', tone: OK, word: 'in progress' };
    case 'completed':
      return { mark: '✓', tone: OK, word: 'completed' };
    case 'failed':
      return { mark: '✗', tone: BAD, word: 'failed' };
    case 'cancelled':
      return { mark: '–', tone: undefined, word: 'cancelled' };
    default:
      return { mark: '○', tone: undefined, word: t.assigned_to ? 'pending' : 'unclaimed' };
  }
}

type ViewProps = {
  el: El;
  on: Actions;
  /** The key the ring starts on when the pane takes the keys: drawn `autoFocus`. */
  auto: string | null;
};

/** `autoFocus` for the element `auto` names. */
const af = (auto: string | null, key: string) => (auto === key ? { autoFocus: true as const } : {});

/** A section heading: bold, with an optional dim count or aside. */
function Heading({ el, title, aside }: { el: El; title: string; aside?: string }) {
  const { Text } = el;
  return (
    <Text wrap="truncate">
      <Text bold>{title}</Text>
      {aside ? <Text dimColor> {aside}</Text> : null}
    </Text>
  );
}

const LABEL = 11;

/** A label column beside a value that wraps under itself. */
function Fact({ el, label, children }: { el: El; label: string; children: unknown }) {
  const { Box, Text } = el;
  return (
    <Box columnGap={1}>
      <Box width={LABEL} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        {children as never}
      </Box>
    </Box>
  );
}

/** One part of a summary line: dim text, or text with its own look. */
export type Part = string | { text: string; color?: string; bold?: boolean };

const partText = (p: Part) => (typeof p === 'string' ? p : p.text);

/**
 * Parts in lines of at most `width` columns, joined by ` sep `: a narrow pane breaks the
 * line between two parts, never inside one, and no line ends or starts on `sep`.
 */
export function packParts(parts: Part[], width: number, sep = '·'): Part[][] {
  const lines: Part[][] = [];
  let used = 0;
  for (const p of parts) {
    const line = lines.at(-1);
    const len = cols(partText(p));
    if (line && used + sep.length + 2 + len <= width) {
      line.push(p);
      used += sep.length + 2 + len;
    } else {
      lines.push([p]);
      used = len;
    }
  }
  return lines;
}

function Parts({
  el,
  parts,
  width,
  sep = '·',
}: {
  el: El;
  parts: (Part | false)[];
  width: number;
  sep?: string;
}) {
  const { Box, Text } = el;
  const lines = packParts(
    parts.filter((p): p is Part => Boolean(p)),
    width,
    sep,
  );
  return (
    <Box flexDirection="column">
      {lines.map((line, l) => (
        <Text key={`line:${l}`} wrap="truncate">
          {line.map((p, i) => {
            const { text, color: tone, bold } = typeof p === 'string' ? { text: p } : p;
            return (
              <Text key={`part:${i}`}>
                {i > 0 ? <Text dimColor> {sep} </Text> : null}
                <Text {...color(tone)} {...(bold ? { bold } : tone ? {} : { dimColor: true })}>
                  {text}
                </Text>
              </Text>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}

export type PaneProps = Omit<ViewProps, 'auto'> & {
  /** Where the ring lands (`landing()` in register.tsx); it starts there on a take. */
  landing: string | null;
  snap: AgentTasksSnapshot;
  route: AgentTasksRoute;
  filter: string;
  detail: AgentTasksDetail | null;
  expanded: string[];
  confirm: string | null;
  form: AgentTasksForm | null;
  draft: AgentTasksDraft;
  rev: number;
  /** Refresh's key (`refreshKey`): a landing waits for the drawing that has it. */
  frame: number;
  busy: string | null;
  notice: string | null;
  /** The key of the element holding the ring (`ui.focus`). */
  focused: string | null;
  /** The pane holds the keyboard (Tab walks it), as the Pane site reports. */
  isFocused: boolean;
  /** The pane body's width (`bodyColumns`). */
  columns: number;
  /** The order the board and Done keep while the pane holds the keyboard (`pinOrder`). */
  pinned: AgentTasksPinned | null;
  /** This session's open tasks. */
  mine: number[];
};

/**
 * The key of an action form's field: drawn anew, under a new key, each time a refused submit
 * puts the words back (Enter clears a field, which takes text from state only when new).
 */
export const formKey = (f: Pick<AgentTasksForm, 'action' | 'drawn'>) =>
  `form:${f.action}${f.drawn ? `:${f.drawn}` : ''}`;

const TABS: [AgentTasksTab, string, string][] = [
  ['board', 'Board', '1'],
  ['done', 'Done', '2'],
  ['new', 'New', '3'],
];

/** The key hint under the tabs, longest first: the longest that fits the pane is drawn. */
const KEYS = [
  'Tab moves · Enter presses · ↑↓ scroll · Esc to the prompt',
  'Tab moves · Enter presses · Esc to the prompt',
  'Tab · Enter · Esc to the prompt',
];
/** On a Select ↑↓ pick its option, not scroll the pane. */
const CHOOSING = [
  'Tab moves · ↑↓ choose · Enter picks · Esc to the prompt',
  'Tab · ↑↓ choose · Enter picks · Esc',
];
const UNFOCUSED = ['ctrl+x tab to work this pane from the keyboard', 'ctrl+x tab: keyboard'];
/** In a text field the hotkeys type into it: the hint says how out instead. */
const TYPING = ['Tab leaves the field · Esc to the prompt', 'Tab leaves · Esc to the prompt'];
/** In a New field Tab goes on to the next one and Enter creates the task. */
const TYPING_NEW = [
  'Tab next field · Enter creates · Esc to the prompt',
  'Tab next · Enter creates · Esc',
];
/** The text fields' keys: Find, the New fields, the comment field, an action form's field. */
export const isField = (key: string | null) =>
  key !== null && /^(find|new-\w+|comment|form):/.test(key);
/**
 * What Find matches, longest first: the longest that fits beside `Find: ` and, while the
 * field has the focus, ` ⏎ find` (13 columns) is drawn, so the hint never wraps.
 */
const FINDS = ['id, title, agent, project or tag', 'id, title, agent, project'];
const fitting = (hints: string[], width: number) =>
  hints.find((h) => cols(h) <= width) ?? hints.at(-1)!;

/** An outcome's tone, by the mark `act` in register.tsx leads it with: ✓ done, ✗ failed. */
/** ✓ done, ✗ refused or failed, ! changed elsewhere, – nothing happened (default). */
const noticeTone = (notice: string) =>
  notice.startsWith('✓')
    ? { color: OK }
    : notice.startsWith('✗')
      ? { color: BAD }
      : notice.startsWith('!')
        ? { color: WARN }
        : {};

/** Why there is no board: nothing answers, or an agent-tasks from before the board does. */
function Down({ el, snap }: { el: El; snap: AgentTasksSnapshot }) {
  const { Box, Text } = el;
  return (
    <Box flexDirection="column">
      <Text color={BAD} bold>
        {snap.old
          ? `An older agent-tasks (${snap.old}) holds the port`
          : 'The agent-tasks server is not reachable'}
      </Text>
      <Text dimColor>
        {snap.old
          ? `It answers at ${snap.origin} but has no board. End the sessions (or the process) still running it: a current one takes the port over. Then Refresh.`
          : `Nothing answers at ${snap.origin}. The agent-tasks MCP server of a running session serves the board: check in /mcp that agent-tasks is connected, then Refresh.`}
      </Text>
    </Box>
  );
}

/** A task's title as the board or Done has it. */
const titleOf = (snap: AgentTasksSnapshot, id: number | undefined) =>
  id === undefined
    ? null
    : ([...snap.open, ...snap.recent].find((t) => t.id === id)?.title ?? null);

export function Pane(p: PaneProps) {
  const { Box, Text, Button } = p.el;
  const { snap, route, on } = p;
  const width = p.columns;
  const isTyping = p.isFocused && isField(p.focused);

  let body;
  if (!snap.isUp) body = <Down el={p.el} snap={snap} />;
  else if (route.task !== null)
    body =
      p.detail?.id === route.task ? (
        <Detail
          el={p.el}
          on={on}
          auto={p.landing}
          d={p.detail}
          route={route}
          expanded={p.expanded}
          confirm={p.confirm}
          form={p.form}
          rev={p.rev}
          width={width}
          isMine={p.mine.includes(p.detail.id)}
          backTitle={titleOf(snap, route.trail.at(-1))}
        />
      ) : (
        <p.el.Progress label={`#${route.task}`} valueText="loading…" />
      );
  else if (route.tab === 'board')
    body = (
      <Board
        el={p.el}
        on={on}
        auto={p.landing}
        snap={snap}
        filter={p.filter}
        rev={p.rev}
        width={width}
        expanded={p.expanded}
        pinned={p.pinned?.board ?? null}
        mine={p.mine}
      />
    );
  else if (route.tab === 'done')
    body = (
      <Done
        el={p.el}
        on={on}
        auto={p.landing}
        snap={snap}
        width={width}
        filter={p.filter}
        pinned={p.pinned?.done ?? null}
      />
    );
  else
    body = (
      <NewTask
        el={p.el}
        on={on}
        auto={p.landing}
        draft={p.draft}
        snap={snap}
        rev={p.rev}
        width={width}
      />
    );

  return (
    <Box flexDirection="column" gap={1} width={width}>
      <Box flexDirection="column">
        <Box flexWrap="wrap" columnGap={2}>
          {/* The tab shown takes its key too: pressed again it lands the ring on its first row.
              Drawn while the server is down too, so a digit stays in the pane. */}
          {TABS.map(([tab, label, hotkey]) => (
            <Button
              key={`tab:${tab}`}
              {...af(p.landing, `tab:${tab}`)}
              label={label}
              {...(isTyping ? {} : { hotkey })}
              plain
              {...(route.tab === tab ? {} : { dimColor: true })}
              onPress={() => on.go(tab)}
            >
              {route.tab === tab && route.task === null ? (
                <Text bold underline>
                  {label}
                </Text>
              ) : (
                label
              )}
            </Button>
          ))}
          <Button
            key={refreshKey(snap.isUp, p.frame)}
            label="Refresh"
            {...(isTyping ? {} : { hotkey: 'r' })}
            plain
            {...af(p.landing, refreshKey(snap.isUp, p.frame))}
            onPress={on.refresh}
          />
        </Box>
        {/* One status line under the tabs: the action in flight, else its outcome, else the
            keys. Only an outcome long enough to wrap (a refusal's reason) takes more. */}
        {p.busy ? (
          <p.el.Progress label={p.busy} valueText="…" color={WARN} />
        ) : p.notice ? (
          <Text {...noticeTone(p.notice)} wrap="wrap">
            {p.notice}
          </Text>
        ) : (
          <Text dimColor wrap="truncate">
            {fitting(
              isTyping
                ? p.focused?.startsWith('new-')
                  ? TYPING_NEW
                  : TYPING
                : p.isFocused
                  ? p.focused === 'form-stage'
                    ? CHOOSING
                    : KEYS
                  : UNFOCUSED,
              width,
            )}
          </Text>
        )}
      </Box>
      {body}
    </Box>
  );
}

type RowProps = ViewProps & {
  t: AgentTasksTask;
  facts: (Part | false | null | undefined)[];
  width: number;
  /** A third line: a finished task's result, in red for a failure. */
  result?: string | null;
};

/**
 * Mark, id and title as one Button, cut to one line, the priority right after it (no
 * priority draws nothing: a '' child would take a column and wrap the title); its facts
 * beneath; then any result.
 */
function Row({ el, on, auto, t, facts, width, result }: RowProps) {
  const { Box, Text, Button } = el;
  const lk = look(t, t.blocked_by.length > 0);
  const prio = t.priority ? `p${t.priority}` : '';
  const room = width - 4 - String(t.id).length - (prio ? prio.length + 1 : 0);
  return (
    <Box flexDirection="column">
      <Box columnGap={1}>
        <Box flexShrink={1}>
          <Button
            key={`open:${t.id}`}
            {...af(auto, `open:${t.id}`)}
            plain
            onPress={() => on.open(t.id)}
          >
            <Text {...color(lk.tone)}>{lk.mark}</Text> <Text dimColor>#{t.id}</Text>{' '}
            {clip(t.title.replace(/\s+/g, ' '), Math.max(10, room))}
          </Button>
        </Box>
        {prio ? (
          <Box flexShrink={0}>
            <Text {...(t.priority >= 5 ? { color: WARN } : { dimColor: true })}>{prio}</Text>
          </Box>
        ) : null}
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor wrap="truncate">
          {fitFacts(facts, width - 2).map((f, i) =>
            typeof f === 'string' ? (
              `${i > 0 ? ' · ' : ''}${f}`
            ) : (
              <Text {...color(f.color)}>
                {i > 0 ? ' · ' : ''}
                {f.text}
              </Text>
            ),
          )}
        </Text>
      </Box>
      {result ? (
        <Box paddingLeft={2}>
          <Text wrap="truncate" {...(t.status === 'failed' ? { color: BAD } : { dimColor: true })}>
            {firstLine(result)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function Board({
  el,
  on,
  auto,
  snap,
  filter,
  rev,
  width,
  expanded,
  pinned,
  mine,
}: ViewProps & {
  snap: AgentTasksSnapshot;
  filter: string;
  rev: number;
  width: number;
  expanded: string[];
  pinned: number[] | null;
  mine: number[];
}) {
  const { Box, Text, Button, Input } = el;
  if (snap.open.length === 0)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>Nothing open on the board.</Text>
          <Text dimColor>
            Tasks agents create land here, by pipeline stage.
            {snap.recent.length ? ` ${plural(snap.recent.length, 'recent one')} under Done.` : ''}
          </Text>
        </Box>
        <Button
          key="empty-new"
          label="New task"
          variant="primary"
          {...af(auto, 'empty-new')}
          onPress={on.newTask}
        />
      </Box>
    );
  const n = tally(snap.open);
  const groups = boardGroups(snap, filter, expanded, pinned);
  const shownCount = groups.reduce((sum, g) => sum + g.tasks.length + g.hidden, 0);
  const isFiltered = filter !== '';

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Parts
          el={el}
          width={width}
          parts={[
            { text: plural(n.open, 'open task'), bold: true },
            `${n.working} in progress`,
            n.blocked > 0 && { text: `${n.blocked} blocked`, color: WARN },
            isFiltered && { text: `${shownCount} shown`, color: ACCENT },
          ]}
        />
        {groups.length > 0 && (
          <Parts
            el={el}
            width={width}
            parts={groups.map((g) => `${g.stage} ${g.tasks.length + g.hidden}`)}
          />
        )}
      </Box>
      {Input && (
        <Box flexDirection="column">
          <Input
            key={`find:${rev}`}
            label="Find"
            placeholder={fitting(FINDS, width - 13)}
            value={filter}
            submitLabel="find"
            onInput={on.typing}
            onSubmit={on.find}
          />
          {isFiltered && (
            <Button
              key="clear-filter"
              label="Clear the filter"
              {...af(auto, 'clear-filter')}
              onPress={on.clearFilter}
            />
          )}
        </Box>
      )}
      {shownCount === 0 && <Text dimColor>No open task matches.</Text>}
      {groups.map((g) => {
        // A find shows every match, folded or not: no toggle that would do nothing.
        const isUnfolded = !isFiltered && g.hidden === 0 && expanded.includes(`stage:${g.stage}`);
        // Unfolded, the toggle stays where it was: the rows it showed follow it.
        const at = isUnfolded ? Math.min(FOLD_ROWS, g.tasks.length) : g.tasks.length;
        const row = (t: AgentTasksTask) => (
          <Row
            key={`row:${t.id}`}
            el={el}
            on={on}
            auto={auto}
            t={t}
            width={width}
            facts={[
              t.blocked_by.length > 0 && {
                text: `waits for ${t.blocked_by.map((b) => `#${b}`).join(', ')}`,
                color: WARN,
              },
              mine.includes(t.id) && { text: 'this session', color: ACCENT },
              t.assigned_to ?? 'unclaimed',
              t.subtasks && `${t.subtasks.done}/${t.subtasks.total} subtasks`,
              t.parent_id !== null && `part of #${t.parent_id}`,
              t.project,
              ...tagsFound(t, filter).map((tag) => ({ text: `tag ${tag}`, color: ACCENT })),
              ago(t.updated_at),
            ]}
          />
        );
        return (
          <Box key={`stage:${g.stage}`} flexDirection="column">
            <Heading el={el} title={cap(g.stage)} aside={String(g.tasks.length + g.hidden)} />
            {g.tasks.slice(0, at).map(row)}
            {(g.hidden > 0 || isUnfolded) && (
              <Button
                key={foldKey(`stage:${g.stage}`, isUnfolded)}
                plain
                dimColor
                label={g.hidden > 0 ? `▸ ${g.hidden} more` : '▾ Show less'}
                onPress={() => on.toggle(`stage:${g.stage}`)}
              />
            )}
            {g.tasks.slice(at).map(row)}
          </Box>
        );
      })}
    </Box>
  );
}

function Done({
  el,
  on,
  auto,
  snap,
  width,
  filter,
  pinned,
}: ViewProps & {
  snap: AgentTasksSnapshot;
  width: number;
  filter: string;
  pinned: number[] | null;
}) {
  const { Box, Text, Button } = el;
  if (snap.recent.length === 0)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>Nothing finished yet.</Text>
          <Text dimColor>Tasks land here once they are completed, failed or cancelled.</Text>
        </Box>
        <Box>
          <Button
            key="empty-board"
            label="Board"
            variant="primary"
            {...af(auto, 'empty-board')}
            onPress={() => on.go('board')}
          />
        </Box>
      </Box>
    );
  // The board's find holds here too: a finished task is found where it now is.
  const shown = pinOrder(
    snap.recent.filter((t) => matches(t, filter)),
    pinned,
  );
  return (
    <Box flexDirection="column" gap={1}>
      <Heading el={el} title="Recently finished" aside="newest first" />
      {filter !== '' && (
        <Box flexDirection="column">
          <Text>
            {`${plural(shown.length, 'finished task')} ${shown.length === 1 ? 'matches' : 'match'} "${filter}"`}
          </Text>
          <Button
            key="clear-filter"
            label="Clear the filter"
            {...af(auto, 'clear-filter')}
            onPress={on.clearFilter}
          />
        </Box>
      )}
      <Box flexDirection="column" gap={1}>
        {shown.map((t) => (
          <Row
            key={`row:${t.id}`}
            el={el}
            on={on}
            auto={auto}
            t={t}
            width={width}
            facts={[`${look(t).word} ${ago(t.updated_at)}`, t.assigned_to, t.project]}
            result={t.result}
          />
        ))}
      </Box>
    </Box>
  );
}

/** The New tab's priority as typed: empty is 0, anything but a whole number null. */
export function priorityOf(d: AgentTasksDraft): number | null {
  const n = d.priority.trim() === '' ? 0 : Number(d.priority);
  return Number.isInteger(n) ? n : null;
}

/**
 * Each field's hints, longest first: the longest that fits beside its label and `⏎ next`
 * is drawn, so no hint wraps, in the narrowest dock neither.
 */
const FIELDS: [keyof AgentTasksDraft, string, string[]][] = [
  ['title', 'Title', ['what needs doing']],
  ['project', 'Project', ['groups the board']],
  ['priority', 'Priority', ['whole number, higher goes first', 'integer, high first']],
  ['tags', 'Tags', ['comma separated']],
  ['description', 'Description', ['optional']],
];

function NewTask({
  el,
  on,
  auto,
  draft,
  snap,
  rev,
  width,
}: ViewProps & { draft: AgentTasksDraft; snap: AgentTasksSnapshot; rev: number; width: number }) {
  const { Box, Text, Button, Input } = el;
  if (!Input)
    return <Text dimColor>New tasks are created where a text field can be typed in.</Text>;
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Heading
          el={el}
          title="New task"
          aside={`lands in ${snap.stages[0] ?? 'backlog'}, unclaimed`}
        />
        <Text dimColor>Tab moves to the next field; Enter in any field creates the task.</Text>
      </Box>
      <Box flexDirection="column">
        {FIELDS.map(([field, label, hints]) => (
          <Fact key={`field:${field}`} el={el} label={label}>
            <Input
              key={`new-${field}:${rev}`}
              {...af(auto, `new-${field}:${rev}`)}
              placeholder={fitting(hints, width - LABEL - 1 - ' ⏎ create'.length)}
              value={draft[field]}
              submitLabel="create"
              {...(field === 'description' ? { rows: 3 } : {})}
              onInput={(v) => on.edit(field, v)}
              onSubmit={(v) => on.submitField(field, v)}
            />
            {field === 'priority' && priorityOf(draft) === null && (
              <Text color={BAD}>a whole number, like 0 or 5</Text>
            )}
          </Fact>
        ))}
      </Box>
      <Box flexWrap="wrap" columnGap={1}>
        <Button key="create" label="Create" variant="primary" onPress={on.create} />
        <Button key="clear-draft" label="Clear" onPress={on.clearDraft} />
      </Box>
    </Box>
  );
}

type DetailProps = ViewProps & {
  /** The task is one this session holds. */
  isMine: boolean;
  /** The title of the task the way back goes to, when it is one. */
  backTitle: string | null;
  d: AgentTasksDetail;
  route: AgentTasksRoute;
  expanded: string[];
  confirm: string | null;
  form: AgentTasksForm | null;
  rev: number;
  width: number;
};

const DESC_LINES = 8;
/** A description folds only when that hides at least this many lines. */
const DESC_FOLD = 6;
export const COMMENTS_SHOWN = 5;

/**
 * A list of related tasks, each a Button that opens it, marked as the board marks it; the
 * mark is part of the Button, so the focus shows the whole row, and a long title wraps.
 */
function Refs({ el, on, auto, k, refs }: ViewProps & { k: string; refs: AgentTasksRef[] }) {
  const { Box, Text, Button } = el;
  return (
    <Box flexDirection="column">
      {refs.map((r) => {
        const lk = look(r, r.isBlocked);
        return (
          <Button
            key={`${k}:${r.id}`}
            {...af(auto, `${k}:${r.id}`)}
            plain
            onPress={() => on.open(r.id)}
          >
            <Text wrap="wrap">
              <Text {...color(lk.tone)}>{lk.mark}</Text> #{r.id} {r.title.replace(/\s+/g, ' ')}
              <Text dimColor> · {r.stage}</Text>
            </Text>
          </Button>
        );
      })}
    </Box>
  );
}

function Detail({
  el,
  on,
  auto,
  d,
  route,
  expanded,
  confirm,
  form,
  rev,
  width,
  isMine,
  backTitle,
}: DetailProps) {
  const { Box, Text, Button, Input, Markdown } = el;
  const waiting = d.blockers.filter((b) => isOpen(b.status));
  const lk = look(d, waiting.length > 0);
  const stages = activeStages(d);
  const idx = stages.indexOf(d.stage);
  const step = nextStep(d);
  const isLive = isOpen(d.status);
  const isWorking = d.status === 'in_progress';
  const openSubtasks = d.subtasks.filter((t) => isOpen(t.status)).length;
  const atEnd = step === completeKey(d.stage);
  // Advance and Complete only when nothing it waits for, and no gate the pane cannot pass,
  // would refuse them.
  const reachable = waiting.length === 0 && !isOutOfReach(d.gate);
  const descLines = d.description.split('\n');
  const isDescFolding = descLines.length >= DESC_LINES + DESC_FOLD;
  const isDescOpen = expanded.includes('desc') || !isDescFolding;
  const isAllComments = expanded.includes('comments');
  const comments = isAllComments ? d.comments : d.comments.slice(-COMMENTS_SHOWN);
  const backLabel = route.trail.length
    ? clip(backTitle ?? `#${route.trail.at(-1)}`, 40)
    : route.tab === 'done'
      ? 'Done'
      : 'Board';
  const wrap = (s: string, tone?: string) => (
    <Text {...color(tone)} wrap="wrap">
      {s}
    </Text>
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Button
          key="back"
          label={`‹ ${backLabel}`}
          plain
          dimColor
          {...af(auto, 'back')}
          onPress={on.back}
        />
        <Text wrap="wrap">
          <Text dimColor>#{d.id} </Text>
          <Text bold>{d.title}</Text>
        </Text>
        <Parts
          el={el}
          width={width}
          parts={[
            { text: `${lk.mark} ${lk.word}`, ...(lk.tone ? { color: lk.tone } : {}) },
            isMine && { text: 'this session', color: ACCENT },
            d.assigned_to ?? false,
            d.priority ? `p${d.priority}` : false,
            d.project ?? false,
          ]}
        />
        {d.status !== 'cancelled' && (
          <Parts
            el={el}
            width={width}
            sep="›"
            parts={stages.map((s, i) =>
              i === idx ? { text: s, color: d.status === 'failed' ? BAD : ACCENT, bold: true } : s,
            )}
          />
        )}
      </Box>

      {confirm === `delete:${d.id}` ? (
        <Box flexDirection="column" borderStyle="round" borderColor={BAD} paddingX={1}>
          <Text color={BAD} wrap="wrap">
            {deleteQuestion(d)}
          </Text>
          <Box columnGap={1}>
            <Button
              key="confirm-no"
              label={d.subtree.open.length ? 'Back' : 'Keep it'}
              {...af(auto, 'confirm-no')}
              onPress={on.dismiss}
            />
            {/* Open work below it is someone's: the server refuses, so nothing to press. */}
            {d.subtree.open.length === 0 && (
              <Button key="confirm-yes" label={`Delete #${d.id}`} onPress={() => on.remove(d.id)} />
            )}
          </Box>
        </Box>
      ) : form?.task === d.id ? (
        <Box flexDirection="column">
          <ActionForm el={el} on={on} auto={auto} d={d} form={form} />
          {form.action === 'complete' && openSubtasks > 0 && (
            <Text color={WARN} wrap="wrap">
              {`${plural(openSubtasks, 'subtask')} still open: completing #${d.id} does not close ${openSubtasks === 1 ? 'it' : 'them'}.`}
            </Text>
          )}
          {/* Complete passes the gate too: its form says what it holds for. */}
          {form.action === 'complete' && d.gate && (
            <Text color={WARN} wrap="wrap">
              {gateHint(d.gate, d.stage)}
            </Text>
          )}
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box flexWrap="wrap" columnGap={1}>
            {isWorking && reachable && !atEnd && idx >= 0 && idx < stages.length - 1 && (
              <Button
                key={`advance:${stages[idx + 1]}`}
                {...af(auto, `advance:${stages[idx + 1]}`)}
                label={`Advance › ${stages[idx + 1]}`}
                {...(step === `advance:${stages[idx + 1]}` && !d.gate
                  ? { variant: 'primary' as const }
                  : {})}
                onPress={() => on.advance(d.id, stages[idx + 1]!)}
              />
            )}
            {isWorking && reachable && (
              <Button
                key={completeKey(d.stage)}
                {...af(auto, completeKey(d.stage))}
                label="Complete"
                {...(atEnd && !d.gate ? { variant: 'primary' as const } : {})}
                onPress={() => on.ask(d.id, 'complete')}
              />
            )}
            {isLive && idx > 0 && (
              <Button
                key="ask:regress"
                label="‹ Send back"
                onPress={() => on.ask(d.id, 'regress')}
              />
            )}
            {d.status === 'in_progress' && (
              <Button key="ask:fail" label="Fail" onPress={() => on.ask(d.id, 'fail')} />
            )}
            {/* The two that drop the task wrap together, never one alone on a line. */}
            <Box columnGap={1}>
              {isLive && (
                <Button key="ask:cancel" label="Cancel" onPress={() => on.ask(d.id, 'cancel')} />
              )}
              {!isLive && <Button key="reopen" label="Reopen" onPress={() => on.reopen(d.id)} />}
              <Button key="ask-delete" label="Delete" onPress={() => on.askDelete(d.id)} />
            </Box>
          </Box>
          {d.status === 'pending' && (
            <Text dimColor wrap="wrap">
              {d.assigned_to
                ? `Waiting for ${d.assigned_to} to start it.`
                : 'Unclaimed: it moves on once an agent claims it.'}
            </Text>
          )}
          {isWorking && waiting.length === 0 && d.gate && (
            <Text color={WARN} wrap="wrap">
              {gateHint(d.gate, d.stage)}
            </Text>
          )}
          {isWorking && waiting.length > 0 && (
            <Text color={WARN} wrap="wrap">
              It moves on once {waiting.map((b) => `#${b.id}`).join(', ')}{' '}
              {waiting.length === 1 ? 'is' : 'are'} done.
            </Text>
          )}
        </Box>
      )}

      <Box flexDirection="column">
        {d.result && (
          <Fact
            el={el}
            label={d.status === 'failed' ? 'Error' : d.status === 'cancelled' ? 'Reason' : 'Result'}
          >
            {wrap(d.result, d.status === 'failed' ? BAD : undefined)}
          </Fact>
        )}
        {waiting.length > 0 && (
          <Fact el={el} label="Waits for">
            <Refs el={el} on={on} auto={auto} k="dep" refs={waiting} />
          </Fact>
        )}
        {isLive && d.blocking.length > 0 && (
          <Fact el={el} label="Blocks">
            <Refs el={el} on={on} auto={auto} k="blocks" refs={d.blocking} />
          </Fact>
        )}
        {['related', 'duplicate'].map((kind) => {
          const refs = d.links.filter((l) => l.relationship === kind);
          return refs.length > 0 ? (
            <Fact key={`links:${kind}`} el={el} label={cap(kind)}>
              <Refs el={el} on={on} auto={auto} k={kind} refs={refs} />
            </Fact>
          ) : null;
        })}
        {d.parent && (
          <Fact el={el} label="Part of">
            <Refs el={el} on={on} auto={auto} k="parent" refs={[d.parent]} />
          </Fact>
        )}
        {d.tags.length > 0 && (
          <Fact el={el} label="Tags">
            {wrap(d.tags.join(', '))}
          </Fact>
        )}
        <Fact el={el} label="Created">
          {wrap(`${when(d.created_at)} by ${d.created_by}`)}
        </Fact>
        <Fact el={el} label="Updated">
          {wrap(when(d.updated_at))}
        </Fact>
      </Box>

      {d.description.trim() !== '' && (
        <Box flexDirection="column">
          <Heading el={el} title="Description" />
          <Markdown
            text={
              isDescOpen ? d.description.trim() : descLines.slice(0, DESC_LINES).join('\n').trim()
            }
          />
          {isDescFolding && (
            <Button
              key={foldKey('desc', expanded.includes('desc'))}
              label={
                expanded.includes('desc') ? '▾ Show less' : `▸ Show all ${descLines.length} lines`
              }
              plain
              dimColor
              onPress={() => on.toggle('desc')}
            />
          )}
        </Box>
      )}

      {d.subtasks.length > 0 && (
        <Box flexDirection="column">
          <Heading
            el={el}
            title="Subtasks"
            aside={`${d.subtasks.filter((s) => s.status === 'completed').length}/${d.subtasks.length} done`}
          />
          <Refs el={el} on={on} auto={auto} k="sub" refs={d.subtasks} />
        </Box>
      )}

      {(isLive || d.artifacts.length > 0) && (
        <Box flexDirection="column">
          <Heading el={el} title="Artifacts" aside={String(d.artifacts.length)} />
          {d.artifacts.length === 0 && <Text dimColor>None yet.</Text>}
          {d.artifacts.map((a) => {
            const part = `art:${a.id}`;
            const isUnfolded = expanded.includes(part);
            return (
              <Box key={`artrow:${a.id}`} flexDirection="column">
                <Box columnGap={1}>
                  {/* The name clips at its end, never splits a word; the facts beside it give way first. */}
                  <Box flexShrink={1}>
                    <Button key={foldKey(part, isUnfolded)} plain onPress={() => on.toggle(part)}>
                      <Text wrap="truncate">
                        {isUnfolded ? '▾' : '▸'} {a.name}
                      </Text>
                    </Button>
                  </Box>
                  <Box flexShrink={10}>
                    <Text dimColor wrap="truncate">
                      {[
                        `by ${a.created_by}`,
                        when(a.created_at),
                        a.stage !== a.name && `in ${a.stage}`,
                        a.version > 1 && `v${a.version}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </Box>
                </Box>
                {isUnfolded && (
                  <Box flexDirection="column" paddingLeft={2}>
                    <Markdown text={fitTables(a.content, width - 2)} />
                    {a.cut > 0 && <Text dimColor>… {a.cut} more characters not shown</Text>}
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      <Box flexDirection="column">
        <Heading el={el} title="Comments" aside={String(d.commentCount)} />
        {d.comments.length > COMMENTS_SHOWN && (
          <Button
            key={foldKey('comments', isAllComments)}
            label={isAllComments ? '▾ Show less' : `▸ ${d.comments.length - COMMENTS_SHOWN} more`}
            plain
            dimColor
            onPress={() => on.toggle('comments')}
          />
        )}
        {comments.map((c) => (
          <Box key={`c:${c.id}`} flexDirection="column">
            <Text wrap="truncate">
              <Text bold>{c.author}</Text>
              <Text dimColor> {when(c.created_at)}</Text>
            </Text>
            <Box paddingLeft={2}>
              <Text wrap="wrap">{c.content}</Text>
            </Box>
          </Box>
        ))}
        {Input && (
          <Input
            key={`comment:${rev}`}
            label="Comment"
            placeholder="add one"
            submitLabel="send"
            rows={3}
            onInput={on.typing}
            onSubmit={(v) => on.comment(d.id, v)}
          />
        )}
      </Box>
    </Box>
  );
}

/**
 * Each action's field. Labels sit in the Fact column and hints are short: beside the
 * `⏎ <submit>` hint they fit the narrowest dock's box on one line.
 */
const FORM: Record<
  AgentTasksForm['action'],
  { label: string; hint: string; submit: string; button: string; tone: string }
> = {
  complete: {
    label: 'Result',
    hint: 'the outcome',
    submit: 'complete',
    button: 'Complete',
    tone: OK,
  },
  fail: { label: 'Error', hint: 'what went wrong', submit: 'fail', button: 'Fail', tone: BAD },
  cancel: {
    label: 'Reason',
    hint: 'why drop it',
    submit: 'cancel',
    button: 'Cancel task',
    tone: WARN,
  },
  regress: { label: 'Why', hint: 'optional note', submit: 'send', button: 'Send back', tone: WARN },
};

const TITLES: Record<AgentTasksForm['action'], (d: AgentTasksDetail) => string> = {
  complete: (d) => `Complete #${d.id}`,
  fail: (d) => `Mark #${d.id} failed`,
  cancel: (d) => `Cancel #${d.id}`,
  regress: (d) => `Send #${d.id} back to an earlier stage`,
};

/** The words an action needs, in a box under the stage strip; Enter or its button does it. */
function ActionForm({
  el,
  on,
  auto,
  d,
  form,
}: ViewProps & { d: AgentTasksDetail; form: AgentTasksForm }) {
  const { Box, Text, Button, Input, Select } = el;
  const f = FORM[form.action];
  const earlier = activeStages(d).slice(0, Math.max(0, activeStages(d).indexOf(d.stage)));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={f.tone} paddingX={1}>
      <Text color={f.tone} bold>
        {TITLES[form.action](d)}
      </Text>
      {form.action === 'regress' && Select && earlier.length > 0 && (
        <Fact el={el} label="Back to">
          <Select
            key="form-stage"
            {...af(auto, 'form-stage')}
            value={form.stage ?? earlier.at(-1)!}
            options={earlier.map((s) => ({ value: s, label: s }))}
            onSelect={on.pickStage}
          />
        </Fact>
      )}
      {Input && (
        <Fact el={el} label={f.label}>
          <Input
            key={formKey(form)}
            {...af(auto, formKey(form))}
            placeholder={f.hint}
            {...(form.seed ? { value: form.seed } : {})}
            submitLabel={f.submit}
            rows={2}
            onInput={on.type}
            onSubmit={(v) => on.finish(d.id, form.action, v)}
          />
        </Fact>
      )}
      {form.action === 'regress' && (form.stage ?? earlier.at(-1)) === activeStages(d)[0] && (
        <Text dimColor wrap="wrap">
          {`Back in ${activeStages(d)[0]} it is unclaimed: any agent may claim it.`}
        </Text>
      )}
      <Box columnGap={1}>
        <Button
          key="form-submit"
          label={f.button}
          variant="primary"
          onPress={() => on.finish(d.id, form.action)}
        />
        <Button key="form-dismiss" label="Never mind" onPress={on.dismiss} />
      </Box>
    </Box>
  );
}
