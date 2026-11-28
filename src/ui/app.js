/* global document, setTimeout, clearTimeout, CSS */
// =============================================================================
// The dashboard and the widget: one app over a data source. The source is the
// REST API (dashboard.js) or the host's tool calls (widget.js); both answer
//   load() -> { snap, meta }, task(id, snap) -> detail, act(id, body),
//   comment(id, text), create(fields) -> task, remove(id)
// and say whether they `poll` (the dashboard) or refresh on demand (the widget).
// State lives here; every change draws the regions again (mount keeps focus).
// =============================================================================

import { h, mount } from './lib/dom.js';
import { facetsOf } from './lib/model.js';
import { board, done } from './views/board.js';
import { detail } from './views/detail.js';
import { stats } from './views/stats.js';

const TABS = [
  ['board', 'Board'],
  ['done', 'Done'],
  ['stats', 'Stats'],
];
const POLL_MS = 3_000;
const NOTICE_MS = 6_000;

const logo = () =>
  h(
    'span',
    { class: 'logo', 'aria-hidden': 'true' },
    h('span', null),
    h('span', null),
    h('span', null),
  );

export function createApp(root, source, opts = {}) {
  const state = {
    meta: null,
    isUp: null,
    error: '',
    snap: null,
    tab: 'board',
    taskId: null,
    detail: null,
    detailError: '',
    filter: { find: '', project: '', assignee: '' },
    form: null,
    confirmDelete: false,
    busy: '',
    notice: null,
    solo: Boolean(opts.solo),
  };
  const drafts = new Map();
  const opened = new Set();
  let lastOpened = null;
  let timer = null;
  let noticeTimer = null;
  let loading = null;
  let lastSnap = '';
  let lastDetail = '';

  const els = {
    header: h('header', { class: 'top' }),
    toolbar: h('div', { class: 'toolbar', role: 'search', 'aria-label': 'Filter tasks' }),
    notice: h('div', { class: 'notice-region', role: 'status', 'aria-live': 'polite' }),
    main: h('main', { class: 'main', id: 'main', tabindex: '-1' }),
    panel: h('aside', { class: 'panel', 'aria-label': 'Task detail' }),
  };
  const layout = h('div', { class: 'layout' }, els.main, els.panel);
  mount(
    root,
    h('a', { class: 'skip', href: '#main' }, 'Skip to content'),
    els.header,
    els.toolbar,
    els.notice,
    layout,
  );
  const dialog = createDialog();
  document.body.append(dialog.el);

  const ui = {
    state,
    open(id) {
      go(state.tab, id);
    },
    close() {
      go(state.tab, null);
      setTimeout(
        () =>
          root.querySelector(`[data-key="open:${CSS.escape(String(lastOpened ?? ''))}"]`)?.focus(),
        0,
      );
    },
    draft: (key) => drafts.get(key) ?? '',
    setDraft: (key, value) => drafts.set(key, value),
    isOpen: (key) => opened.has(key),
    setOpen: (key, isOpenNow) => (isOpenNow ? opened.add(key) : opened.delete(key)),
    setForm(form) {
      state.form = form;
      state.confirmDelete = false;
      draw();
      if (form)
        focusSoon(form.action === 'regress' ? 'form-stage' : `form:${form.task}:${form.action}`);
      else focusSoon('ask:complete', 'ask:regress', 'close');
    },
    confirmDelete(isAsking) {
      state.confirmDelete = isAsking;
      state.form = null;
      draw();
      focusSoon(isAsking ? 'confirm-no' : 'ask-delete');
    },
    act(id, body, draftKey) {
      const label = {
        advance: 'Advanced',
        complete: 'Completed',
        fail: 'Marked failed',
        cancel: 'Cancelled',
        regress: 'Sent back',
        reopen: 'Reopened',
      }[body.action];
      return run(`#${id}`, async () => {
        await source.act(id, body);
        if (draftKey) drafts.delete(draftKey);
        state.form = null;
        say(
          `${label} #${id}${body.action === 'advance' ? ` to ${body.stage}` : body.action === 'regress' ? ` to ${body.stage}` : ''}.`,
          'success',
        );
      });
    },
    comment(id, text, draftKey) {
      return run(`#${id}`, async () => {
        await source.comment(id, text);
        drafts.delete(draftKey);
        say(`Comment added to #${id}.`, 'success');
      });
    },
    remove(id) {
      return run(`#${id}`, async () => {
        await source.remove(id);
        state.confirmDelete = false;
        say(`Deleted #${id}.`, 'success');
        go(state.tab, null);
      });
    },
  };

  function focusSoon(...keys) {
    setTimeout(() => {
      for (const k of keys) {
        const el = root.querySelector(`[data-key="${CSS.escape(k)}"]`);
        if (el) return el.focus();
      }
      els.main.focus({ preventScroll: true });
    }, 0);
  }

  function say(text, tone = 'info') {
    state.notice = { text, tone };
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      state.notice = null;
      drawNotice();
    }, NOTICE_MS);
    drawNotice();
  }

  async function run(what, fn) {
    if (state.busy) return;
    state.busy = what;
    draw();
    try {
      await fn();
    } catch (err) {
      say(`✗ ${err.message}`, 'danger');
    } finally {
      if (loading) await loading;
      await refresh();
      state.busy = '';
      draw();
      if (!root.contains(document.activeElement))
        focusSoon('ask:complete', 'ask:regress', 'ask:cancel', 'ask-delete', 'close');
    }
  }

  function go(tab, id, { push = true } = {}) {
    const changed = id !== state.taskId;
    state.tab = tab;
    if (changed) {
      if (id !== null) lastOpened = id;
      state.taskId = id;
      state.detail = null;
      state.detailError = '';
      state.form = null;
      state.confirmDelete = false;
      lastDetail = '';
    }
    if (push && opts.route) opts.route.write(tab, id);
    draw();
    if (changed && id !== null) loadDetail().then(() => focusSoon('close'));
  }

  async function loadDetail() {
    const id = state.taskId;
    if (id === null || !state.isUp) return;
    try {
      const d = await source.task(id, state.snap);
      if (state.taskId !== id) return;
      const key = JSON.stringify(d);
      state.detailError = '';
      if (key === lastDetail) return;
      lastDetail = key;
      state.detail = d;
      if (state.form && d.status !== 'in_progress' && d.status !== 'pending') state.form = null;
    } catch (err) {
      if (state.taskId !== id) return;
      state.detail = null;
      state.detailError = err.message;
    }
    drawPanel();
  }

  async function refresh() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const { snap, meta } = await source.load();
        const wasDown = state.isUp === false;
        state.isUp = true;
        state.error = '';
        if (meta) state.meta = meta;
        const key = JSON.stringify(snap);
        if (key !== lastSnap || wasDown) {
          lastSnap = key;
          state.snap = snap;
          draw();
        } else drawHeader();
        await loadDetail();
      } catch (err) {
        const wasUp = state.isUp !== false;
        state.isUp = false;
        state.error = err.message;
        if (wasUp) draw();
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  function schedule() {
    clearTimeout(timer);
    if (!source.poll) return;
    timer = setTimeout(async () => {
      if (!document.hidden) await refresh();
      schedule();
    }, POLL_MS);
  }

  function drawHeader() {
    const st =
      state.isUp === null
        ? ['connecting', 'Connecting…']
        : state.isUp
          ? ['up', source.poll ? 'Live' : 'Connected']
          : ['down', 'Offline'];
    mount(
      els.header,
      h(
        'div',
        { class: 'brand' },
        logo(),
        h('h1', { class: 'brand-name' }, 'agent-tasks'),
        state.meta?.version ? h('span', { class: 'version' }, `v${state.meta.version}`) : null,
        h(
          'span',
          {
            class: ['server', `is-${st[0]}`],
            title: state.isUp === false ? state.error : (state.meta?.url ?? ''),
          },
          h('span', { class: 'dot', 'aria-hidden': 'true' }),
          st[1],
        ),
      ),
      state.solo
        ? null
        : h(
            'nav',
            { class: 'tabs', 'aria-label': 'Views' },
            TABS.map(([tab, label]) =>
              h(
                'button',
                {
                  type: 'button',
                  class: ['tab', state.tab === tab && 'is-active'],
                  'data-key': `tab:${tab}`,
                  'aria-current': state.tab === tab ? 'page' : null,
                  on: {
                    click: () => go(tab, state.taskId && tab === state.tab ? state.taskId : null),
                  },
                },
                label,
                tab === 'board' && state.snap
                  ? h('span', { class: 'count' }, String(state.snap.open.length))
                  : null,
              ),
            ),
          ),
      h(
        'div',
        { class: 'top-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn',
            'data-key': 'refresh',
            title: 'Refresh now',
            'aria-label': 'Refresh',
            on: { click: () => refresh() },
          },
          '↻',
        ),
        state.solo
          ? null
          : h(
              'button',
              {
                type: 'button',
                class: 'btn primary',
                'data-key': 'new',
                disabled: !state.isUp,
                on: { click: () => dialog.show() },
              },
              '+ New task',
            ),
      ),
    );
  }

  function drawToolbar() {
    if (state.solo || !state.snap || state.tab === 'stats') return mount(els.toolbar);
    const f = facetsOf(state.snap);
    const isFiltered = () =>
      Boolean(state.filter.find || state.filter.project || state.filter.assignee);
    const set = (k) => (e) => {
      const was = isFiltered();
      state.filter = { ...state.filter, [k]: e.target.value };
      if (was !== isFiltered()) drawToolbar();
      drawMain();
    };
    const picker = (k, all, values) =>
      h(
        'select',
        { 'data-key': `facet:${k}`, 'aria-label': all, on: { change: set(k) } },
        h('option', { value: '' }, all),
        values.map((v) => h('option', { value: v, selected: state.filter[k] === v }, v)),
      );
    mount(
      els.toolbar,
      h(
        'label',
        { class: 'find' },
        h('span', { class: 'find-icon', 'aria-hidden': 'true' }, '⌕'),
        h('input', {
          type: 'search',
          'data-key': 'find',
          'aria-label': 'Find tasks',
          placeholder: 'Find: id, title, agent, project or tag  ( / )',
          value: state.filter.find,
          autocomplete: 'off',
          on: { input: set('find') },
        }),
      ),
      f.projects.length > 1 || state.filter.project
        ? picker('project', 'All projects', f.projects)
        : null,
      f.assignees.length > 1 || state.filter.assignee
        ? picker('assignee', 'All assignees', f.assignees)
        : null,
      isFiltered()
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn ghost',
              'data-key': 'clear',
              on: {
                click: () => {
                  state.filter = { find: '', project: '', assignee: '' };
                  drawToolbar();
                  drawMain();
                },
              },
            },
            'Clear',
          )
        : null,
    );
  }

  function drawNotice() {
    const n = state.busy ? { text: `Working on ${state.busy}…`, tone: 'info' } : state.notice;
    mount(els.notice, n ? h('div', { class: ['notice', `tone-${n.tone}`] }, n.text) : null);
  }

  function down() {
    const url = state.meta?.url ?? (source.origin ? `${source.origin}/` : 'the agent-tasks server');
    return h(
      'section',
      { class: 'down', role: 'alert' },
      h('h2', null, 'The agent-tasks server is not reachable'),
      h(
        'p',
        null,
        `Nothing answers at ${url}. The REST API (and this dashboard) runs while any agent-tasks MCP process runs, or start it with `,
        h('code', null, 'npx agent-tasks dashboard'),
        '.',
      ),
      h('p', { class: 'muted' }, state.error),
      h(
        'button',
        {
          type: 'button',
          class: 'btn primary',
          'data-key': 'retry',
          on: { click: () => refresh() },
        },
        'Try again',
      ),
    );
  }

  function drawMain() {
    if (state.isUp === false && !state.snap) return mount(els.main, down());
    if (!state.snap)
      return mount(
        els.main,
        h('div', { class: 'loading', 'aria-busy': 'true' }, 'Loading the board…'),
      );
    if (state.solo) return mount(els.main);
    const view = state.tab === 'done' ? done(ui) : state.tab === 'stats' ? stats(ui) : board(ui);
    mount(els.main, state.isUp === false ? down() : null, view);
  }

  function drawPanel() {
    layout.classList.toggle('has-panel', state.taskId !== null);
    layout.classList.toggle('is-solo', state.solo);
    if (state.taskId === null) return mount(els.panel);
    const body = state.detail
      ? detail(ui, state.detail, { solo: state.solo })
      : state.detailError
        ? h(
            'div',
            { class: 'detail' },
            h(
              'div',
              { class: 'detail-head' },
              h('span', { class: 'card-id' }, `#${state.taskId}`),
              state.solo
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn icon',
                      'data-key': 'close',
                      'aria-label': 'Close',
                      on: { click: () => ui.close() },
                    },
                    '×',
                  ),
            ),
            h('p', { class: 'notice tone-danger' }, state.detailError),
          )
        : h('div', { class: 'loading', 'aria-busy': 'true' }, `Loading #${state.taskId}…`);
    mount(els.panel, body);
  }

  function draw() {
    drawHeader();
    drawToolbar();
    drawNotice();
    drawMain();
    drawPanel();
  }

  function createDialog() {
    const fields = {
      title: h('input', { name: 'title', required: true, maxlength: '500', autocomplete: 'off' }),
      description: h('textarea', { name: 'description', rows: 5, placeholder: 'Markdown' }),
      project: h('input', { name: 'project', list: 'projects', autocomplete: 'off' }),
      priority: h('input', {
        name: 'priority',
        type: 'number',
        min: '0',
        max: '100',
        step: '1',
        value: '0',
      }),
      tags: h('input', { name: 'tags', placeholder: 'comma, separated', autocomplete: 'off' }),
    };
    const projects = h('datalist', { id: 'projects' });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const label = (text, el, hint) =>
      h(
        'label',
        { class: 'field' },
        h('span', null, text, hint ? h('span', { class: 'muted' }, ` ${hint}`) : null),
        el,
      );
    const el = h(
      'dialog',
      { class: 'dialog', 'aria-labelledby': 'new-title' },
      h(
        'form',
        {
          method: 'dialog',
          on: {
            submit: async (e) => {
              e.preventDefault();
              const title = fields.title.value.trim();
              if (!title) return fields.title.focus();
              const body = {
                title,
                ...(fields.description.value.trim()
                  ? { description: fields.description.value.trim() }
                  : {}),
                ...(fields.project.value.trim() ? { project: fields.project.value.trim() } : {}),
                ...(Number(fields.priority.value)
                  ? { priority: Number(fields.priority.value) }
                  : {}),
                ...(fields.tags.value.trim()
                  ? {
                      tags: fields.tags.value
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean),
                    }
                  : {}),
              };
              error.textContent = '';
              try {
                const t = await source.create(body);
                el.close();
                for (const f of Object.values(fields)) f.value = f === fields.priority ? '0' : '';
                say(`Created #${t.id}.`, 'success');
                await refresh();
                go('board', Number(t.id));
              } catch (err) {
                error.textContent = err.message;
              }
            },
          },
        },
        h(
          'header',
          { class: 'dialog-head' },
          h('h2', { id: 'new-title' }, 'New task'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn icon',
              'aria-label': 'Close',
              on: { click: () => el.close() },
            },
            '×',
          ),
        ),
        label('Title', fields.title),
        label('Description', fields.description, '(optional)'),
        h(
          'div',
          { class: 'field-row' },
          label('Project', fields.project),
          label('Priority', fields.priority),
        ),
        label('Tags', fields.tags),
        projects,
        error,
        h(
          'div',
          { class: 'actions end' },
          h('button', { type: 'button', class: 'btn', on: { click: () => el.close() } }, 'Cancel'),
          h(
            'button',
            { type: 'submit', class: 'btn primary', 'data-key': 'create' },
            'Create task',
          ),
        ),
      ),
    );
    return {
      el,
      show() {
        const known = state.snap ? facetsOf(state.snap).projects : [];
        mount(
          projects,
          known.map((p) => h('option', { value: p })),
        );
        if (!fields.project.value && state.filter.project)
          fields.project.value = state.filter.project;
        error.textContent = '';
        el.showModal();
        fields.title.focus();
      },
    };
  }

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    if (e.key === 'Escape' && !dialog.el.open && state.taskId !== null && !state.solo) {
      if (state.form || state.confirmDelete) ui.setForm(null);
      else ui.close();
    } else if (e.key === '/' && !typing && !dialog.el.open) {
      const find = root.querySelector('[data-key="find"]');
      if (find) {
        e.preventDefault();
        find.focus();
      }
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && source.poll) refresh();
  });

  return {
    ui,
    async start(initial = {}) {
      if (initial.tab) state.tab = initial.tab;
      if (initial.taskId !== undefined && initial.taskId !== null) {
        state.taskId = initial.taskId;
        lastOpened = initial.taskId;
      }
      draw();
      await refresh();
      schedule();
    },
    route: (tab, id) => go(tab, id, { push: false }),
    refresh,
    say,
  };
}
