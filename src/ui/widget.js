/* global document, window */
// =============================================================================
// ui://agent-tasks/app.html: the MCP Apps widget. The same app as the web
// dashboard, over the host's tool calls instead of REST: a task_list result
// draws as the board (refreshed by calling task_list again with the same
// arguments), a single task (task_get, task_create) as its detail. Actions go
// through task_stage, task_artifact, task_create and task_delete.
// =============================================================================

import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { h, mount } from './lib/dom.js';
import { DEFAULT_STAGES, detail, snapshotOf } from './lib/model.js';
import { resultOf, viewOf } from './lib/view.js';
import { createApp } from './app.js';

const root = document.getElementById('root');
document.body.classList.add('is-widget');
const app = new App({ name: 'agent-tasks', version: '1.0.0' }, {}, { autoResize: true });

const textOf = (res) =>
  (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

async function call(name, args) {
  const res = await app.callServerTool({ name, arguments: args });
  if (res.isError) throw new Error(textOf(res).replace(/^Error \[\w+\]: /, '') || `${name} failed`);
  return resultOf(res);
}

const pipelines = new Map();
async function stagesOf(project) {
  const key = project ?? '';
  if (!pipelines.has(key)) {
    const got = await call('task_config', {
      action: 'pipeline',
      ...(project ? { project } : {}),
    }).catch(() => null);
    pipelines.set(key, Array.isArray(got?.stages) ? got.stages.map(String) : DEFAULT_STAGES);
  }
  return pipelines.get(key);
}

let input = {};
let shown = null;
let instance = null;

const source = {
  poll: false,
  async load() {
    const stages = await stagesOf(null);
    if (shown.view === 'board') {
      const sc = shown.isFresh ? shown.sc : await call('task_list', input);
      shown = { view: 'board', sc, isFresh: false };
      return { snap: snapshotOf(sc.tasks, stages), meta: null };
    }
    return { snap: snapshotOf([shown.sc], stages), meta: null };
  },
  async task(id, snap) {
    const t = await call('task_get', { task_id: id, include: ['subtasks', 'comments'] });
    const parent =
      typeof t.parent_id === 'number'
        ? await call('task_get', { task_id: t.parent_id }).catch(() => null)
        : null;
    return detail(
      t,
      await stagesOf(typeof t.project === 'string' ? t.project : null),
      snap,
      parent,
    );
  },
  act: (id, body) => call('task_stage', { task_id: id, ...body }),
  comment: (id, content) => call('task_artifact', { type: 'comment', task_id: id, content }),
  create: (fields) => call('task_create', fields),
  remove: (id) => call('task_delete', { task_id: id }),
};

function theme(hc) {
  if (!hc) return;
  if (hc.theme) applyDocumentTheme(hc.theme);
  if (hc.styles?.variables) applyHostStyleVariables(hc.styles.variables);
  if (hc.styles?.css?.fonts) applyHostFonts(hc.styles.css.fonts);
}

function show(sc) {
  const view = viewOf(sc);
  if (!view) {
    instance = null;
    mount(
      root,
      h(
        'div',
        { class: 'empty' },
        typeof sc?.message === 'string' ? sc.message : 'Nothing to show.',
      ),
    );
    return;
  }
  shown = { view, sc, isFresh: true };
  if (!instance || instance.view !== view) {
    mount(root);
    instance = { view, app: createApp(root, source, { solo: view === 'task' }) };
    instance.app.start(view === 'task' ? { taskId: sc.id } : {});
  } else instance.app.refresh();
}

mount(root, h('div', { class: 'empty' }, 'Waiting for the result…'));
app.addEventListener('hostcontextchanged', theme);
app.addEventListener('toolinput', (p) => {
  input = p.arguments ?? {};
});
app.addEventListener('toolresult', (res) => {
  if (res.isError)
    mount(root, h('div', { class: 'notice tone-danger' }, textOf(res) || 'The tool failed.'));
  else show(resultOf(res));
});
app.addEventListener('toolcancelled', () =>
  mount(root, h('div', { class: 'empty' }, 'Cancelled.')),
);

app
  .connect(new PostMessageTransport(window.parent, window.parent))
  .then(() => theme(app.getHostContext()));
