// =============================================================================
// agent-tasks — Board Module
//
// Kanban board rendering, column headers, gate indicators, card rendering,
// stats display.
// =============================================================================

window.TaskBoard = window.TaskBoard || {};

// ---- Constants ----

var STAGE_ICONS = {
  backlog: 'inbox',
  spec: 'description',
  plan: 'map',
  implement: 'code',
  test: 'science',
  review: 'rate_review',
  done: 'check_circle',
  cancelled: 'cancel',
};

var STAGE_EMPTY_MESSAGES = {
  backlog: { icon: 'inbox', text: 'Nothing in backlog', cta: 'Add a task', ctaIcon: 'add' },
  spec: {
    icon: 'description',
    text: 'No specs yet',
    cta: 'Drag tasks here',
    ctaIcon: 'drag_indicator',
  },
  plan: {
    icon: 'map',
    text: 'No plans in progress',
    cta: 'Drag tasks here',
    ctaIcon: 'drag_indicator',
  },
  implement: {
    icon: 'code',
    text: 'Nothing being built',
    cta: 'Drag tasks here',
    ctaIcon: 'drag_indicator',
  },
  test: {
    icon: 'science',
    text: 'Nothing to test',
    cta: 'Drag tasks here',
    ctaIcon: 'drag_indicator',
  },
  review: {
    icon: 'rate_review',
    text: 'Nothing in review',
    cta: 'Drag tasks here',
    ctaIcon: 'drag_indicator',
  },
  done: { icon: 'check_circle', text: 'No completed tasks', cta: '', ctaIcon: '' },
  cancelled: { icon: 'cancel', text: 'No cancelled tasks', cta: '', ctaIcon: '' },
};

var WIP_WARNING = 5;
var WIP_DANGER = 8;
var CARDS_PER_PAGE = 20;

var _columnVisibleCounts = new Map();

// ---- Gate indicators ----

function renderGateIndicator(stage) {
  var state = TaskBoard.state;
  var esc = TaskBoard.esc;
  let gates = null;
  for (const proj of Object.keys(state.gateConfigs)) {
    const gc = state.gateConfigs[proj];
    if (gc?.gates?.[stage]) {
      gates = gc.gates;
      break;
    }
  }
  if (!gates || !gates[stage]) return '';
  const g = gates[stage];
  const reqs = [];
  if (g.require_artifacts?.length) {
    for (const a of g.require_artifacts) reqs.push(esc(a));
  }
  if (g.require_min_artifacts)
    reqs.push(g.require_min_artifacts + ' artifact' + (g.require_min_artifacts > 1 ? 's' : ''));
  if (g.require_comment) reqs.push('comment');
  if (g.require_approval) reqs.push('approval');
  if (!reqs.length) return '';
  return `<div class="gate-indicator" title="Gate: requires ${reqs.join(', ')} to advance"><span class="material-symbols-outlined">lock</span>${reqs.map((r) => `<span class="gate-req">${r}</span>`).join('')}</div>`;
}

// ---- Status indicator ----

function renderStatusIndicator(status) {
  const icons = {
    in_progress: 'pending',
    completed: 'check_circle',
    failed: 'cancel',
    pending: 'radio_button_unchecked',
    cancelled: 'block',
  };
  const icon = icons[status];
  if (!icon) return '';
  return `<span class="task-status-indicator status-${status}"><span class="material-symbols-outlined">${icon}</span></span>`;
}

// ---- Collaborators ----

function renderCollaborators(collabs) {
  var esc = TaskBoard.esc;
  if (!collabs || collabs.length === 0) return '';
  const maxVisible = 3;
  const visible = collabs.slice(0, maxVisible);
  const overflow = collabs.length - maxVisible;
  let html = '<div class="task-card-collabs">';
  for (const c of visible) {
    const initials = TaskBoard.avatarInitials(c.agent_id);
    const color = TaskBoard.avatarColor(c.agent_id);
    html += `<div class="collab-avatar" style="background:${color}" title="${esc(c.agent_id)} (${esc(c.role)})">${esc(initials)}</div>`;
  }
  if (overflow > 0) {
    html += `<div class="collab-overflow" title="${collabs.length} collaborators">+${overflow}</div>`;
  }
  html += '</div>';
  return html;
}

// ---- Card rendering ----

function renderCard(task, isBlocked, stage, index) {
  var state = TaskBoard.state;
  var esc = TaskBoard.esc;
  var relativeTime = TaskBoard.relativeTime;
  var renderAvatar = TaskBoard.renderAvatar;

  const tags = [];

  if (task.project) {
    tags.push(`<span class="task-tag tag-project">${esc(task.project)}</span>`);
  }
  if (task.priority > 0) {
    tags.push(`<span class="task-tag tag-priority">P${task.priority}</span>`);
  }
  const artCount = state.artifactCounts[task.id];
  if (artCount) {
    tags.push(`<span class="task-tag tag-artifacts">${artCount} art.</span>`);
  }
  const cmtCount = state.commentCounts[task.id];
  if (cmtCount) {
    tags.push(`<span class="task-tag tag-comments">${cmtCount} cmt.</span>`);
  }
  if (isBlocked) {
    tags.push(`<span class="task-tag tag-blocked">blocked</span>`);
  }

  const progress = state.subtaskProgress[task.id];
  let progressBar = '';
  if (progress && progress.total > 0) {
    const pct = Math.round((progress.done / progress.total) * 100);
    tags.push(`<span class="task-tag tag-subtasks">${progress.done}/${progress.total}</span>`);
    progressBar = `<div class="subtask-progress"><div class="subtask-progress-fill" style="width:${pct}%"></div></div>`;
  }

  const priorityClass =
    task.priority >= 5 ? ' priority-high' : task.priority >= 3 ? ' priority-medium' : '';

  const statusClass =
    task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
      ? ` status-${task.status}`
      : '';

  const descPreview = task.description ? task.description.split('\n')[0].substring(0, 120) : '';

  const timeAgo = relativeTime(task.updated_at);

  const assigneeAvatar = task.assigned_to ? renderAvatar(task.assigned_to) : '';

  const isActive = state.panelTaskId === task.id;
  const activeClass = isActive ? ' active-card' : '';

  const statusIndicator = renderStatusIndicator(task.status);

  const collabs = state.collaborators[task.id] || [];
  const collabHtml = renderCollaborators(collabs);

  return `<div class="task-card${priorityClass}${statusClass}${activeClass}" tabindex="0" draggable="true"
       data-task-id="${task.id}" data-stage="${esc(stage)}"
       role="option"
       style="animation-delay: ${index * 30}ms"
       aria-label="Task #${task.id}: ${esc(task.title)}">
    <div class="task-card-header">
      <span class="task-card-id">#${task.id}${statusIndicator}</span>
      ${timeAgo ? `<span class="task-card-time">${esc(timeAgo)}</span>` : ''}
    </div>
    <div class="task-card-title" data-action="edit-title" data-task-id="${task.id}">${esc(task.title)}</div>
    ${descPreview ? `<div class="task-card-desc">${esc(descPreview)}</div>` : ''}
    <div class="task-card-footer">
      <div class="task-card-meta">${tags.join('')}</div>
      ${assigneeAvatar ? `<div class="task-card-assignee" data-action="change-assignee" data-task-id="${task.id}">${assigneeAvatar}</div>` : ''}
    </div>
    ${collabHtml}
    ${progressBar}
  </div>`;
}

// ---- Board rendering ----

function renderBoard() {
  var state = TaskBoard.state;
  var esc = TaskBoard.esc;
  var morph = TaskBoard.morph;
  var getFilteredTasks = TaskBoard.getFilteredTasks;
  var getBlockedTaskIds = TaskBoard.getBlockedTaskIds;

  const board = TaskBoard._root.getElementById('board');
  const blocked = getBlockedTaskIds();
  const filtered = getFilteredTasks();
  const visibleStages = state.stages.filter((s) => s !== 'cancelled');

  if (state.tasks.length === 0) {
    morph(
      board,
      `<div class="board-empty">
        <span class="material-symbols-outlined">view_kanban</span>
        <h3>No tasks yet</h3>
        <p>Create tasks via MCP tools (task_create) or the REST API (POST /api/tasks) to get started.</p>
        <div class="empty-steps">
          <div class="empty-step">
            <span class="material-symbols-outlined">add_task</span>
            <span>Create a task</span>
          </div>
          <div class="empty-step">
            <span class="material-symbols-outlined">drag_indicator</span>
            <span>Drag through stages</span>
          </div>
          <div class="empty-step">
            <span class="material-symbols-outlined">check_circle</span>
            <span>Complete the work</span>
          </div>
        </div>
      </div>`,
    );
    return;
  }

  const byStage = {};
  for (const s of state.stages) byStage[s] = [];
  for (const t of filtered) {
    if (byStage[t.stage]) byStage[t.stage].push(t);
    else byStage[t.stage] = [t];
  }

  for (const s of Object.keys(byStage)) {
    byStage[s].sort((a, b) => b.priority - a.priority);
  }

  const columnsToShow = [...visibleStages];
  if (byStage['cancelled']?.length > 0 && !columnsToShow.includes('cancelled')) {
    columnsToShow.push('cancelled');
  }

  morph(
    board,
    columnsToShow
      .map((stage) => {
        const tasks = byStage[stage] || [];
        const isCollapsed = state.collapsedColumns.has(stage);
        const colClass = isCollapsed ? 'kanban-column collapsed' : 'kanban-column';
        const icon = STAGE_ICONS[stage] || 'label';

        let countClass = 'column-count';
        if (tasks.length >= WIP_DANGER) countClass += ' wip-danger';
        else if (tasks.length >= WIP_WARNING) countClass += ' wip-warning';

        const emptyMsg = STAGE_EMPTY_MESSAGES[stage] || {
          icon: 'label',
          text: 'No tasks',
          cta: '',
        };

        var visibleCount = _columnVisibleCounts.get(stage) || CARDS_PER_PAGE;
        var remaining = Math.max(0, tasks.length - visibleCount);

        let bodyContent;
        let showMoreHtml = '';
        if (tasks.length === 0 && !isCollapsed) {
          bodyContent = `<div class="column-empty">
        <span class="material-symbols-outlined">${emptyMsg.icon}</span>
        <div class="empty-text">${esc(emptyMsg.text)}</div>
        ${emptyMsg.cta ? `<div class="empty-cta" data-action="add-task" data-stage="${esc(stage)}">${emptyMsg.ctaIcon ? `<span class="material-symbols-outlined">${emptyMsg.ctaIcon}</span>` : ''}${esc(emptyMsg.cta)}</div>` : ''}
      </div>`;
        } else {
          var visibleTasks = tasks.slice(0, visibleCount);
          bodyContent = visibleTasks
            .map((t, i) => renderCard(t, blocked.has(t.id), stage, i))
            .join('');
          if (remaining > 0 && !isCollapsed) {
            showMoreHtml = `<button class="column-show-more-btn" data-action="show-more" data-stage="${esc(stage)}">
        <span class="material-symbols-outlined">expand_more</span> Show more (${remaining} remaining)
      </button>`;
          }
        }

        const gateHtml = renderGateIndicator(stage);

        return `<div class="${colClass}" id="col-${esc(stage)}" data-stage="${esc(stage)}">
      <div class="column-header" data-action="toggle-collapse" data-stage="${esc(stage)}">
        <div class="column-header-left">
          <span class="material-symbols-outlined">${icon}</span>
          <h3>${esc(stage)}</h3>
        </div>
        <span class="${countClass}" aria-label="${tasks.length} tasks">${tasks.length}</span>
      </div>${gateHtml}
      <div class="column-body" role="listbox" aria-label="${esc(stage)} tasks">
        ${bodyContent}
      </div>
      ${showMoreHtml}
      ${
        !isCollapsed
          ? `<button class="column-add-btn" data-action="inline-create" data-stage="${esc(stage)}">
        <span class="material-symbols-outlined">add</span> New task
      </button>`
          : ''
      }
    </div>`;
      })
      .join(''),
  );

  requestAnimationFrame(() => {
    const cards = board.querySelectorAll('.task-card:not(.no-anim):not(.animated)');
    cards.forEach((card, i) => {
      card.classList.add('animated');
      card.style.animationDelay = `${i * 30}ms`;
      card.classList.add('animate-in');
    });
  });
}

// ---- Stats rendering ----

var _lastStatValues = {};

function renderStats() {
  var state = TaskBoard.state;
  var morph = TaskBoard.morph;

  const total = state.tasks.length;
  const active = state.tasks.filter((t) => t.status === 'in_progress').length;
  const pending = state.tasks.filter((t) => t.status === 'pending').length;
  const done = state.tasks.filter((t) => t.status === 'completed').length;

  const statsEl = TaskBoard._root.getElementById('stats');
  const values = { total, active, pending, done };

  morph(
    statsEl,
    `<span class="stat">Total <span class="stat-value" data-stat="total">${total}</span></span>` +
      `<span class="stat">Active <span class="stat-value" data-stat="active">${active}</span></span>` +
      `<span class="stat">Pending <span class="stat-value" data-stat="pending">${pending}</span></span>` +
      `<span class="stat">Done <span class="stat-value" data-stat="done">${done}</span></span>`,
  );

  for (const key of Object.keys(values)) {
    if (_lastStatValues[key] !== undefined && _lastStatValues[key] !== values[key]) {
      const el = statsEl.querySelector(`[data-stat="${key}"]`);
      if (el) {
        el.classList.remove('pulse');
        void el.offsetWidth;
        el.classList.add('pulse');
      }
    }
  }
  _lastStatValues = values;
}

// ---- Column pagination ----

function showMoreCards(stage) {
  var current = _columnVisibleCounts.get(stage) || CARDS_PER_PAGE;
  _columnVisibleCounts.set(stage, current + CARDS_PER_PAGE);
}

function resetColumnVisibleCounts() {
  _columnVisibleCounts.clear();
}

// ---- Register on namespace ----

TaskBoard.STAGE_ICONS = STAGE_ICONS;
TaskBoard.STAGE_EMPTY_MESSAGES = STAGE_EMPTY_MESSAGES;
TaskBoard.WIP_WARNING = WIP_WARNING;
TaskBoard.WIP_DANGER = WIP_DANGER;
TaskBoard.renderGateIndicator = renderGateIndicator;
TaskBoard.renderStatusIndicator = renderStatusIndicator;
TaskBoard.renderCollaborators = renderCollaborators;
TaskBoard.renderCard = renderCard;
TaskBoard.renderBoard = renderBoard;
TaskBoard.renderStats = renderStats;
TaskBoard.showMoreCards = showMoreCards;
TaskBoard.resetColumnVisibleCounts = resetColumnVisibleCounts;
