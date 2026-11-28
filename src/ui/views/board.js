// =============================================================================
// Board: the stat tiles and the kanban (a column per stage, a card per task).
// Done: the recently closed tasks. Both open a task's detail on a press.
// =============================================================================

import { h } from '../lib/dom.js';
import { ago, columns, finished, look, parseTs, plural, tally, when } from '../lib/model.js';

export function chip(text, tone = 'muted', attrs = {}) {
  return h('span', { class: ['chip', `tone-${tone}`, attrs.class], title: attrs.title }, text);
}

function tile(n, label, tone) {
  return h(
    'div',
    { class: ['tile', n > 0 && tone ? `tone-${tone}` : null] },
    h('span', { class: 'tile-n' }, String(n)),
    h('span', { class: 'tile-label' }, label),
  );
}

export function tiles(snap) {
  const n = tally(snap.open);
  const failed = snap.recent.filter((t) => t.status === 'failed').length;
  const week = Date.now() - 7 * 86_400_000;
  const done = snap.recent.filter(
    (t) => t.status === 'completed' && parseTs(t.updated_at).getTime() >= week,
  ).length;
  return h(
    'section',
    { class: 'tiles', 'aria-label': 'Summary' },
    tile(n.open, 'open'),
    tile(n.working, 'in progress', 'info'),
    snap.noDeps ? null : tile(n.blocked, 'blocked', 'warning'),
    tile(done, 'done this week', 'success'),
    tile(failed, 'failed lately', 'danger'),
  );
}

function initials(name) {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function who(name) {
  if (!name) return h('span', { class: 'who who-none' }, 'unclaimed');
  return h(
    'span',
    { class: 'who', title: name },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(name)),
    h('span', { class: 'who-name' }, name),
  );
}

function card(t, ui) {
  const blocked = t.blocked_by.length > 0;
  const lk = look(t, blocked);
  const isSelected = ui.state.taskId === t.id;
  return h(
    'article',
    {
      class: ['card', `st-${t.status}`, blocked && 'is-blocked', isSelected && 'is-selected'],
      'data-id': String(t.id),
    },
    h(
      'div',
      { class: 'card-top' },
      h('span', { class: 'card-id' }, `#${t.id}`),
      t.priority > 0
        ? chip(`P${t.priority}`, t.priority >= 5 ? 'danger' : 'warning', {
            title: `Priority ${t.priority}`,
          })
        : null,
      h('span', { class: 'card-age', title: `Updated ${when(t.updated_at)}` }, ago(t.updated_at)),
    ),
    h(
      'h3',
      { class: 'card-title' },
      h(
        'button',
        {
          type: 'button',
          class: 'card-open',
          'data-key': `open:${t.id}`,
          'aria-current': isSelected ? 'true' : null,
          on: { click: () => ui.open(t.id) },
        },
        t.title,
      ),
    ),
    h(
      'div',
      { class: 'card-meta' },
      lk.word === 'unclaimed' ? null : chip(lk.word, lk.tone),
      who(t.assigned_to),
      t.project ? chip(t.project, 'project') : null,
    ),
    t.tags.length || blocked || t.subtasks
      ? h(
          'div',
          { class: 'card-foot' },
          blocked
            ? chip(`waits for ${t.blocked_by.map((id) => `#${id}`).join(', ')}`, 'warning')
            : null,
          t.subtasks ? chip(`${t.subtasks.done}/${t.subtasks.total} subtasks`, 'muted') : null,
          t.tags.slice(0, 3).map((tag) => chip(tag, 'tag')),
          t.tags.length > 3
            ? chip(`+${t.tags.length - 3}`, 'tag', { title: t.tags.slice(3).join(', ') })
            : null,
        )
      : null,
  );
}

export function board(ui) {
  const { snap, filter } = ui.state;
  const cols = columns(snap, filter);
  const shown = cols.reduce((n, c) => n + c.tasks.length, 0);
  if (shown === 0 && snap.open.length > 0)
    return [tiles(snap), h('p', { class: 'empty' }, 'No open task matches the filters.')];
  return [
    tiles(snap),
    h(
      'div',
      {
        class: 'kanban',
        'data-scroll': 'kanban',
        role: 'list',
        'aria-label': 'Open tasks by stage',
      },
      cols.map((c) =>
        h(
          'section',
          {
            class: ['column', c.tasks.length === 0 && 'is-empty'],
            role: 'listitem',
            'aria-label': `${c.stage}: ${plural(c.tasks.length, 'task')}`,
          },
          h(
            'header',
            { class: 'column-head' },
            h('h2', null, c.stage),
            h('span', { class: 'count' }, String(c.tasks.length)),
          ),
          h(
            'div',
            { class: 'column-body' },
            c.tasks.length
              ? c.tasks.map((t) => card(t, ui))
              : h('p', { class: 'column-empty' }, 'Nothing here'),
          ),
        ),
      ),
    ),
  ];
}

export function done(ui) {
  const rows = finished(ui.state.snap, ui.state.filter);
  if (!rows.length)
    return h(
      'p',
      { class: 'empty' },
      ui.state.snap.recent.length
        ? 'No finished task matches the filters.'
        : 'Nothing finished yet.',
    );
  return h(
    'ul',
    { class: 'done-list', 'aria-label': 'Recently finished tasks' },
    rows.map((t) => {
      const lk = look(t);
      return h(
        'li',
        { class: ['done-row', ui.state.taskId === t.id && 'is-selected'], 'data-id': String(t.id) },
        h(
          'div',
          { class: 'done-main' },
          chip(lk.word, lk.tone),
          h('span', { class: 'card-id' }, `#${t.id}`),
          h(
            'button',
            {
              type: 'button',
              class: 'card-open',
              'data-key': `open:${t.id}`,
              on: { click: () => ui.open(t.id) },
            },
            t.title,
          ),
        ),
        h(
          'div',
          { class: 'done-meta' },
          who(t.assigned_to),
          t.project ? chip(t.project, 'project') : null,
          h('span', { class: 'muted' }, `closed in ${t.closed_from ?? t.stage}`),
          h('span', { class: 'muted', title: t.updated_at }, when(t.updated_at)),
        ),
        t.result ? h('p', { class: 'done-result' }, t.result) : null,
      );
    }),
  );
}
