// =============================================================================
// A task's detail: stage strip, the actions the pane allows (Advance, Complete,
// Send back, Fail, Cancel, Reopen, Delete), facts, dependencies, subtasks, the
// description, artifacts and comments (Markdown rendered as text, never HTML),
// and a comment field.
// =============================================================================

import { h } from '../lib/dom.js';
import { markdown } from '../lib/markdown.js';
import { actionsFor, activeStages, gateHint, isOpen, look, plural, when } from '../lib/model.js';
import { chip, who } from './board.js';

const FORMS = {
  complete: {
    title: 'Complete',
    field: 'Result',
    hint: 'What came of it',
    required: true,
    key: 'result',
  },
  fail: {
    title: 'Mark failed',
    field: 'What went wrong',
    hint: 'The error',
    required: true,
    key: 'result',
  },
  cancel: {
    title: 'Cancel',
    field: 'Reason',
    hint: 'Why it is dropped',
    required: true,
    key: 'reason',
  },
  regress: {
    title: 'Send back',
    field: 'Why',
    hint: 'Optional: what needs another pass',
    required: false,
    key: 'reason',
  },
};

function button(label, attrs, onClick) {
  return h(
    'button',
    {
      type: 'button',
      class: ['btn', attrs.kind],
      'data-key': attrs.key,
      title: attrs.title,
      'aria-label': attrs.title,
      disabled: attrs.disabled,
      on: { click: onClick },
    },
    label,
  );
}

function refs(ui, label, items, extra) {
  if (!items.length) return null;
  return h(
    'section',
    { class: 'refs' },
    h('h3', { class: 'section-title' }, label, h('span', { class: 'count' }, String(items.length))),
    h(
      'ul',
      null,
      items.map((r) => {
        const lk = look(r, r.isBlocked);
        return h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              class: 'ref',
              'data-key': `ref:${label}:${r.id}`,
              on: { click: () => ui.open(r.id) },
            },
            h('span', { class: 'card-id' }, `#${r.id}`),
            h('span', { class: 'ref-title' }, r.title),
            extra?.(r),
            chip(isOpen(r.status) ? r.stage : lk.word, lk.tone),
          ),
        );
      }),
    ),
  );
}

function stageStrip(d) {
  const stages = activeStages(d);
  const idx = stages.indexOf(d.stage);
  return h(
    'ol',
    { class: 'stages', 'aria-label': `Stage ${d.stage}` },
    stages.map((st, i) =>
      h(
        'li',
        {
          class: [
            'stage',
            i < idx && 'is-past',
            i === idx && 'is-now',
            i === idx && d.status === 'failed' && 'is-failed',
            i === idx && d.status === 'completed' && 'is-done',
          ],
          'aria-current': i === idx ? 'step' : null,
        },
        st,
      ),
    ),
  );
}

function actionForm(ui, d, form) {
  const spec = FORMS[form.action];
  const draftKey = `form:${d.id}:${form.action}`;
  const submit = (e) => {
    e.preventDefault();
    const words = ui.draft(draftKey).trim();
    if (spec.required && !words) return;
    const body = { action: form.action, ...(words ? { [spec.key]: words } : {}) };
    if (form.action === 'regress') body.stage = form.stage;
    ui.act(d.id, body, draftKey);
  };
  return h(
    'form',
    { class: 'action-form', on: { submit }, 'aria-label': spec.title },
    form.action === 'regress'
      ? h(
          'label',
          { class: 'field' },
          h('span', null, 'Back to'),
          h(
            'select',
            {
              'data-key': 'form-stage',
              on: { change: (e) => ui.setForm({ ...form, stage: e.target.value }) },
            },
            actionsFor(d).regress.map((st) =>
              h('option', { value: st, selected: st === form.stage }, st),
            ),
          ),
        )
      : null,
    h(
      'label',
      { class: 'field' },
      h(
        'span',
        null,
        spec.field,
        spec.required ? null : h('span', { class: 'muted' }, ' (optional)'),
      ),
      h('textarea', {
        rows: 3,
        'data-key': draftKey,
        placeholder: spec.hint,
        required: spec.required,
        value: ui.draft(draftKey),
        on: { input: (e) => ui.setDraft(draftKey, e.target.value) },
      }),
    ),
    form.action === 'complete' && d.subtasks.some((t) => isOpen(t.status))
      ? h(
          'p',
          { class: 'hint tone-warning' },
          `${plural(d.subtasks.filter((t) => isOpen(t.status)).length, 'subtask')} still open: completing #${d.id} does not close them.`,
        )
      : null,
    form.action === 'regress' && form.stage === activeStages(d)[0]
      ? h('p', { class: 'hint' }, `Back in ${form.stage} the task is unclaimed again.`)
      : null,
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        {
          type: 'submit',
          class: ['btn', form.action === 'complete' ? 'primary' : 'danger-soft'],
          'data-key': 'form-submit',
          disabled: Boolean(ui.state.busy),
        },
        spec.title,
      ),
      button('Never mind', { key: 'form-cancel' }, () => ui.setForm(null)),
    ),
  );
}

function actions(ui, d) {
  const a = actionsFor(d);
  const { form, confirmDelete, busy } = ui.state;
  if (confirmDelete) {
    const openBelow = d.subtree.open;
    return h(
      'div',
      { class: 'confirm', role: 'alertdialog', 'aria-label': 'Delete task' },
      h(
        'p',
        null,
        openBelow.length
          ? `#${d.id} has open subtasks (${openBelow.map((id) => `#${id}`).join(', ')}): finish, cancel or delete them first.`
          : `Delete #${d.id} with its artifacts, comments${d.subtree.finished ? ` and ${plural(d.subtree.finished, 'finished subtask')}` : ''}? There is no undo.`,
      ),
      h(
        'div',
        { class: 'actions' },
        openBelow.length
          ? null
          : button(
              `Delete #${d.id}`,
              { kind: 'danger', key: 'confirm-yes', disabled: Boolean(busy) },
              () => ui.remove(d.id),
            ),
        button(openBelow.length ? 'Back' : 'Keep it', { key: 'confirm-no' }, () =>
          ui.confirmDelete(false),
        ),
      ),
    );
  }
  if (form?.task === d.id) return actionForm(ui, d, form);
  const open = (action) => () =>
    ui.setForm({ task: d.id, action, stage: action === 'regress' ? a.regress.at(-1) : null });
  return h(
    'div',
    { class: 'action-block' },
    h(
      'div',
      { class: 'actions', role: 'group', 'aria-label': 'Stage actions' },
      a.advance
        ? button(
            `Advance → ${a.advance}`,
            { kind: a.primary === 'advance' && 'primary', key: 'advance', disabled: Boolean(busy) },
            () => ui.act(d.id, { action: 'advance', stage: a.advance, from: d.stage }),
          )
        : null,
      a.complete
        ? button(
            'Complete',
            { kind: a.primary === 'complete' && 'primary', key: 'ask:complete' },
            open('complete'),
          )
        : null,
      a.regress.length ? button('← Send back', { key: 'ask:regress' }, open('regress')) : null,
      a.fail ? button('Fail', { key: 'ask:fail' }, open('fail')) : null,
      a.cancel ? button('Cancel task', { key: 'ask:cancel' }, open('cancel')) : null,
      a.reopen
        ? button('Reopen', { kind: 'primary', key: 'reopen', disabled: Boolean(busy) }, () =>
            ui.act(d.id, { action: 'reopen' }),
          )
        : null,
      button('Delete', { kind: 'ghost-danger', key: 'ask-delete' }, () => ui.confirmDelete(true)),
    ),
    d.status === 'pending'
      ? h(
          'p',
          { class: 'hint' },
          d.assigned_to
            ? `Waiting for ${d.assigned_to} to start it.`
            : 'Unclaimed: it moves on once an agent claims it (task_stage claim).',
        )
      : null,
    d.status === 'in_progress' && a.waiting.length === 0 && d.gate
      ? h('p', { class: 'hint tone-warning' }, gateHint(d.gate, d.stage))
      : null,
    d.status === 'in_progress' && a.waiting.length > 0
      ? h(
          'p',
          { class: 'hint tone-warning' },
          `It moves on once ${a.waiting.map((b) => `#${b.id}`).join(', ')} ${a.waiting.length === 1 ? 'is' : 'are'} done.`,
        )
      : null,
  );
}

function fact(label, value) {
  if (value === null || value === undefined || value === '') return null;
  return [h('dt', null, label), h('dd', null, value)];
}

function comments(ui, d) {
  const key = `comment:${d.id}`;
  const send = (e) => {
    e.preventDefault();
    const words = ui.draft(key).trim();
    if (words) ui.comment(d.id, words, key);
  };
  return h(
    'section',
    { class: 'comments' },
    h(
      'h3',
      { class: 'section-title' },
      'Comments',
      h('span', { class: 'count' }, String(d.commentCount)),
    ),
    d.comments.length
      ? h(
          'ol',
          { class: 'comment-list' },
          d.comments.map((c) =>
            h(
              'li',
              { class: 'comment' },
              h(
                'div',
                { class: 'comment-head' },
                who(c.author),
                h('time', { datetime: c.created_at, title: c.created_at }, when(c.created_at)),
              ),
              h('div', { class: 'md' }, markdown(c.content)),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No comments yet.'),
    h(
      'form',
      { class: 'comment-form', on: { submit: send }, 'aria-label': 'Add a comment' },
      h('textarea', {
        rows: 2,
        'data-key': key,
        'aria-label': 'Comment',
        placeholder: 'Add a comment (Markdown) · Ctrl+Enter to post',
        value: ui.draft(key),
        on: {
          input: (e) => ui.setDraft(key, e.target.value),
          keydown: (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e);
          },
        },
      }),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            type: 'submit',
            class: 'btn',
            'data-key': 'comment-send',
            disabled: Boolean(ui.state.busy),
          },
          'Post comment',
        ),
      ),
    ),
  );
}

export function detail(ui, d, { solo = false } = {}) {
  const lk = look(
    d,
    d.blockers.some((b) => isOpen(b.status)),
  );
  const related = d.links.filter((l) => l.relationship === 'related');
  const dupes = d.links.filter((l) => l.relationship === 'duplicate');
  return h(
    'article',
    { class: 'detail', 'aria-labelledby': 'detail-title' },
    h(
      'header',
      { class: 'detail-head' },
      h(
        'div',
        { class: 'detail-kicker' },
        h('span', { class: 'card-id' }, `#${d.id}`),
        chip(lk.word, lk.tone),
        d.priority > 0 ? chip(`P${d.priority}`, d.priority >= 5 ? 'danger' : 'warning') : null,
      ),
      solo
        ? null
        : button('×', { kind: 'icon', key: 'close', title: 'Close (Esc)' }, () => ui.close()),
    ),
    h('h2', { id: 'detail-title', class: 'detail-title' }, d.title),
    stageStrip(d),
    actions(ui, d),
    d.result
      ? h(
          'section',
          { class: ['result', d.status === 'failed' && 'tone-danger'] },
          h(
            'h3',
            { class: 'section-title' },
            d.status === 'failed' ? 'Error' : d.status === 'cancelled' ? 'Reason' : 'Result',
          ),
          h('div', { class: 'md' }, markdown(d.result)),
        )
      : null,
    h(
      'dl',
      { class: 'facts' },
      fact('Project', d.project ? chip(d.project, 'project') : null),
      fact('Assignee', who(d.assigned_to)),
      fact('Priority', String(d.priority)),
      fact(
        'Tags',
        d.tags.length
          ? h(
              'span',
              { class: 'chips' },
              d.tags.map((t) => chip(t, 'tag')),
            )
          : null,
      ),
      fact('Created', `${when(d.created_at)} by ${d.created_by || 'unknown'}`),
      fact('Updated', when(d.updated_at)),
    ),
    d.parent ? refs(ui, 'Parent', [d.parent]) : null,
    refs(
      ui,
      'Waits for',
      d.blockers.filter((b) => isOpen(b.status)),
    ),
    isOpen(d.status) ? refs(ui, 'Blocks', d.blocking) : null,
    refs(ui, 'Related', related),
    refs(ui, 'Duplicates', dupes),
    refs(ui, 'Subtasks', d.subtasks),
    h(
      'section',
      { class: 'description' },
      h('h3', { class: 'section-title' }, 'Description'),
      d.description.trim()
        ? h('div', { class: 'md' }, markdown(d.description))
        : h('p', { class: 'muted' }, 'No description.'),
    ),
    d.artifacts.length
      ? h(
          'section',
          { class: 'artifacts' },
          h(
            'h3',
            { class: 'section-title' },
            'Artifacts',
            h('span', { class: 'count' }, String(d.artifacts.length)),
          ),
          d.artifacts.map((a) =>
            h(
              'details',
              {
                class: 'artifact',
                open: ui.isOpen(`artifact:${a.id}`),
                on: { toggle: (e) => ui.setOpen(`artifact:${a.id}`, e.target.open) },
              },
              h(
                'summary',
                { 'data-key': `artifact:${a.id}` },
                h('span', { class: 'artifact-name' }, a.name),
                chip(a.stage, 'muted'),
                a.version > 1 ? chip(`v${a.version}`, 'muted') : null,
                h(
                  'span',
                  { class: 'muted artifact-by' },
                  `${a.created_by} · ${when(a.created_at)}`,
                ),
              ),
              h('div', { class: 'md' }, markdown(a.content)),
            ),
          ),
        )
      : null,
    comments(ui, d),
  );
}
