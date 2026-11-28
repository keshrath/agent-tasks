// =============================================================================
// Stats: the tiles and the charts (open by stage, finished per day, open per
// project and per assignee), each a card with an inline SVG.
// =============================================================================

import { h } from '../lib/dom.js';
import { barList, stageChart, throughputChart } from '../lib/charts.js';
import { breakdown } from '../lib/model.js';
import { tiles } from './board.js';

function panel(title, legend, chart) {
  return h(
    'section',
    { class: 'chart-card' },
    h('header', { class: 'chart-head' }, h('h2', null, title), legend),
    chart,
  );
}

const key = (cls, label) =>
  h('span', { class: 'legend-item' }, h('span', { class: ['swatch', cls] }), label);

export function stats(ui) {
  const { snap } = ui.state;
  const projects = breakdown(snap.open, (t) => t.project ?? 'no project').slice(0, 8);
  const agents = breakdown(snap.open, (t) => t.assigned_to ?? 'unclaimed').slice(0, 8);
  return [
    tiles(snap),
    h(
      'div',
      { class: 'charts' },
      panel(
        'Open by stage',
        h('div', { class: 'legend' }, key('c-working', 'in progress'), key('c-waiting', 'waiting')),
        snap.open.length ? stageChart(snap) : h('p', { class: 'empty' }, 'Nothing open.'),
      ),
      panel(
        'Finished, last 7 days',
        h(
          'div',
          { class: 'legend' },
          key('c-done', 'completed'),
          key('c-failed', 'failed or cancelled'),
        ),
        throughputChart(snap),
      ),
      panel(
        'Open per project',
        null,
        projects.length
          ? barList(projects, 'Open tasks per project')
          : h('p', { class: 'empty' }, 'Nothing open.'),
      ),
      panel(
        'Open per assignee',
        null,
        agents.length
          ? barList(agents, 'Open tasks per assignee')
          : h('p', { class: 'empty' }, 'Nothing open.'),
      ),
    ),
  ];
}
