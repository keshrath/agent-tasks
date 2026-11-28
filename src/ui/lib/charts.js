// =============================================================================
// The Stats charts as plain elements sized by CSS (text stays at its real size
// at any width): open tasks per stage, tasks finished per day, and bar lists.
// Colours come from the stylesheet's tokens, so they follow light and dark.
// Each chart is one role="img" with its text alternative.
// =============================================================================

import { h } from './dom.js';
import { perStage, throughput } from './model.js';

const bar = (cls, n, most) =>
  n ? h('span', { class: ['bar', cls], style: { width: `${(100 * n) / most}%` } }) : null;

function bars(alt, rows) {
  const most = Math.max(1, ...rows.map((r) => r.total));
  return h(
    'div',
    { class: 'chart bars', role: 'img', 'aria-label': alt },
    rows.map((r) => [
      h('span', { class: 'bar-label', title: r.label }, r.label),
      h(
        'span',
        { class: 'bar-track' },
        r.parts.map(([cls, n]) => bar(cls, n, most)),
      ),
      h('span', { class: 'bar-n' }, String(r.total)),
    ]),
  );
}

/** Open tasks per stage as horizontal bars, in progress solid and waiting light. */
export function stageChart(snap) {
  const rows = perStage(snap);
  return bars(
    `Open tasks by stage: ${rows.map((r) => `${r.stage} ${r.working + r.waiting} (${r.working} in progress)`).join(', ')}`,
    rows.map((r) => ({
      label: r.stage,
      total: r.working + r.waiting,
      parts: [
        ['c-working', r.working],
        ['c-waiting', r.waiting],
      ],
    })),
  );
}

/** A bar list (per project, per assignee). */
export function barList(rows, label) {
  return bars(
    `${label}: ${rows.map(([k, n]) => `${k} ${n}`).join(', ')}`,
    rows.map(([k, n]) => ({ label: k, total: n, parts: [['c-accent', n]] })),
  );
}

/** Tasks finished on each of the last 7 days (of the recent ones), completed and not. */
export function throughputChart(snap, now = new Date()) {
  const days = throughput(snap.recent, 7, now);
  const most = Math.max(1, ...days.map((c) => c.done + c.failed));
  const seg = (cls, n) => (n ? h('span', { class: cls, style: { flexGrow: String(n) } }) : null);
  return h(
    'div',
    {
      class: 'chart cols',
      role: 'img',
      'aria-label': `Tasks finished per day, last 7 days: ${days.map((d) => `${d.label} ${d.done} completed, ${d.failed} failed or cancelled`).join('; ')}`,
    },
    days.map((c) => {
      const total = c.done + c.failed;
      return h(
        'div',
        { class: 'col' },
        h(
          'div',
          { class: 'col-plot' },
          h('span', { class: 'col-n' }, total ? String(total) : ''),
          h(
            'span',
            { class: 'col-stack', style: { height: `calc((100% - 18px) * ${total / most})` } },
            seg('c-failed', c.failed),
            seg('c-done', c.done),
          ),
        ),
        h('span', { class: 'col-label' }, c.label),
      );
    }),
  );
}
