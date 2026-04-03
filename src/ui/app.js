// =============================================================================
// agent-tasks — Pipeline dashboard client (main entry)
//
// WebSocket connection, state management, initialization, tab/filter management,
// theme, keyboard navigation, cleanup dialog, theme sync.
// Modules: ui-utils.js, board.js, panel.js, drag.js, inline-edit.js, template.js
// =============================================================================

window.TaskBoard = window.TaskBoard || {};

// ---- State ----

var state = {
  tasks: [],
  dependencies: [],
  artifactCounts: {},
  commentCounts: {},
  subtaskProgress: {},
  collaborators: {},
  stages: ['backlog', 'spec', 'plan', 'implement', 'test', 'review', 'done', 'cancelled'],
  gateConfigs: {},
  collapsedColumns: new Set(),
  panelTaskId: null,
};

TaskBoard.state = state;

TaskBoard._baseUrl = '';
TaskBoard._fetch = function (url, opts) {
  return fetch(TaskBoard._baseUrl + url, opts);
};
TaskBoard._wsUrl = null;
TaskBoard._root = document;

var filters = {
  search: '',
  project: '',
  assignee: '',
  minPriority: 0,
};

var ws = null;
var reconnectTimer = null;
var searchDebounce = null;

// ---- Restore persisted state ----

try {
  var saved = JSON.parse(localStorage.getItem('agent-tasks-filters') || '{}');
  if (saved.search) filters.search = saved.search;
  if (saved.project) filters.project = saved.project;
  if (saved.assignee) filters.assignee = saved.assignee;
  if (saved.minPriority) filters.minPriority = saved.minPriority;
} catch {
  /* ignore */
}

try {
  var collapsed = JSON.parse(localStorage.getItem('agent-tasks-collapsed') || '[]');
  if (Array.isArray(collapsed)) collapsed.forEach((s) => state.collapsedColumns.add(s));
} catch {
  /* ignore */
}

function saveFilters() {
  localStorage.setItem('agent-tasks-filters', JSON.stringify(filters));
}

function saveCollapsed() {
  localStorage.setItem('agent-tasks-collapsed', JSON.stringify([...state.collapsedColumns]));
}

TaskBoard.saveFilters = saveFilters;
TaskBoard.saveCollapsed = saveCollapsed;

// ---- Theme ----

function updateThemeIcon(theme) {
  var icon = TaskBoard._root.querySelector('.theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
}

// ---- Blocked tasks ----

function getBlockedTaskIds() {
  var blocked = new Set();
  var doneOrCancelled = new Set(
    state.tasks.filter((t) => t.stage === 'done' || t.stage === 'cancelled').map((t) => t.id),
  );
  for (var dep of state.dependencies) {
    if (!doneOrCancelled.has(dep.depends_on)) {
      blocked.add(dep.task_id);
    }
  }
  return blocked;
}

TaskBoard.getBlockedTaskIds = getBlockedTaskIds;

// ---- Filters ----

function getFilteredTasks() {
  return state.tasks.filter((t) => {
    if (filters.project && t.project !== filters.project) return false;
    if (filters.assignee && t.assigned_to !== filters.assignee) return false;
    if (filters.minPriority && t.priority < filters.minPriority) return false;
    if (filters.search) {
      var q = filters.search.toLowerCase();
      var inTitle = t.title.toLowerCase().includes(q);
      var inDesc = (t.description || '').toLowerCase().includes(q);
      var inId = `#${t.id}`.includes(q);
      if (!inTitle && !inDesc && !inId) return false;
    }
    return true;
  });
}

TaskBoard.getFilteredTasks = getFilteredTasks;

function updateFilterDropdowns() {
  var esc = TaskBoard.esc;
  var projects = [...new Set(state.tasks.map((t) => t.project).filter(Boolean))].sort();
  var assignees = [...new Set(state.tasks.map((t) => t.assigned_to).filter(Boolean))].sort();

  var projectSelect = TaskBoard._root.getElementById('filter-project');
  var currentProject = projectSelect.value;
  projectSelect.innerHTML =
    '<option value="">All projects</option>' +
    projects.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  projectSelect.value = currentProject;

  var assigneeSelect = TaskBoard._root.getElementById('filter-assignee');
  var currentAssignee = assigneeSelect.value;
  assigneeSelect.innerHTML =
    '<option value="">All assignees</option>' +
    assignees.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
  assigneeSelect.value = currentAssignee;
}

function applyRestoredFilters() {
  var searchInput = TaskBoard._root.getElementById('filter-search');
  if (filters.search && searchInput) searchInput.value = filters.search;
  var projectSelect = TaskBoard._root.getElementById('filter-project');
  if (filters.project && projectSelect) projectSelect.value = filters.project;
  var assigneeSelect = TaskBoard._root.getElementById('filter-assignee');
  if (filters.assignee && assigneeSelect) assigneeSelect.value = filters.assignee;
  var prioritySelect = TaskBoard._root.getElementById('filter-priority');
  if (filters.minPriority && prioritySelect) prioritySelect.value = String(filters.minPriority);
}

// ---- Rendering ----

function render() {
  TaskBoard.renderBoard();
  TaskBoard.renderStats();
}

// ---- WebSocket ----

function connect() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${TaskBoard._wsUrl || location.host}`);
  setConnectionStatus('connecting');

  ws.onopen = () => setConnectionStatus('connected');

  ws.onmessage = (evt) => {
    let data;
    try {
      data = JSON.parse(evt.data);
    } catch {
      return;
    }

    if (data.type === 'reload') {
      location.reload();
      return;
    } else if (data.type === 'state') {
      handleFullState(data);
    } else if (data.type && data.data) {
      handleEvent(data);
    }
  };

  ws.onclose = () => {
    setConnectionStatus('disconnected');
    ws = null;
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => {};
}

function setConnectionStatus(status) {
  var el = TaskBoard._root.getElementById('connection-status');
  el.textContent =
    status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting' : 'Disconnected';
  el.className = 'status-badge ' + status;
}

// ---- State handlers ----

var _lastStateFingerprint = '';

function handleFullState(data) {
  var fp = quickFingerprint(data);
  if (fp === _lastStateFingerprint) return;
  _lastStateFingerprint = fp;

  state.tasks = data.tasks || [];
  state.dependencies = data.dependencies || [];
  state.artifactCounts = data.artifactCounts || {};
  state.commentCounts = data.commentCounts || {};
  state.subtaskProgress = data.subtaskProgress || {};
  state.collaborators = data.collaborators || {};
  if (data.stages) state.stages = data.stages;
  if (data.gateConfigs) state.gateConfigs = data.gateConfigs;
  if (data.version) {
    TaskBoard._root.getElementById('version').textContent = 'v' + data.version;
  }
  updateFilterDropdowns();
  applyRestoredFilters();
  render();
  dismissLoading();
}

function quickFingerprint(data) {
  var tasks = data.tasks || [];
  var fp = tasks.length + ':';
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    fp +=
      t.id + '.' + t.stage + '.' + t.status + '.' + (t.updated_at || '') + '.' + t.priority + ',';
  }
  fp += '|' + (data.dependencies || []).length;
  fp += '|' + JSON.stringify(data.artifactCounts || {});
  fp += '|' + JSON.stringify(data.commentCounts || {});
  fp += '|' + JSON.stringify(data.subtaskProgress || {});
  return fp;
}

function dismissLoading() {
  var overlay = TaskBoard._root.getElementById('loading-overlay');
  if (overlay && !overlay.classList.contains('hidden')) {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.addEventListener(
      'transitionend',
      () => {
        overlay.style.display = 'none';
      },
      { once: true },
    );
  }
}

function handleEvent(event) {
  var d = event.data || {};
  var openPanel = TaskBoard.openPanel;
  var closePanel = TaskBoard.closePanel;
  var showToast = TaskBoard.showToast;

  switch (event.type) {
    case 'task:created': {
      if (d.task) {
        var idx = state.tasks.findIndex((t) => t.id === d.task.id);
        if (idx >= 0) state.tasks[idx] = d.task;
        else state.tasks.unshift(d.task);
      }
      showToast('Task created', d.task?.title || '');
      break;
    }
    case 'task:updated':
    case 'task:claimed':
    case 'task:advanced':
    case 'task:regressed':
    case 'task:completed':
    case 'task:failed':
    case 'task:cancelled': {
      if (d.task) {
        var idx2 = state.tasks.findIndex((t) => t.id === d.task.id);
        if (idx2 >= 0) state.tasks[idx2] = d.task;
        else state.tasks.unshift(d.task);
      }
      break;
    }
    case 'task:deleted': {
      if (d.task) {
        state.tasks = state.tasks.filter((t) => t.id !== d.task.id);
        if (state.panelTaskId === d.task.id) closePanel();
      }
      break;
    }
    case 'artifact:created': {
      if (d.artifact) {
        var tid = d.artifact.task_id;
        state.artifactCounts[tid] = (state.artifactCounts[tid] || 0) + 1;
      }
      break;
    }
    case 'comment:created': {
      if (d.comment) {
        var ctid = d.comment.task_id;
        state.commentCounts[ctid] = (state.commentCounts[ctid] || 0) + 1;
      }
      break;
    }
    case 'dependency:added': {
      if (d.task_id !== undefined && d.depends_on !== undefined) {
        state.dependencies.push({ task_id: d.task_id, depends_on: d.depends_on });
      }
      break;
    }
    case 'dependency:removed': {
      state.dependencies = state.dependencies.filter(
        (dep) => !(dep.task_id === d.task_id && dep.depends_on === d.depends_on),
      );
      break;
    }
    case 'pipeline:configured': {
      if (d.stages) state.stages = d.stages;
      break;
    }
    case 'collaborator:added': {
      if (d.task_id && d.agent_id) {
        if (!state.collaborators[d.task_id]) state.collaborators[d.task_id] = [];
        var existing = state.collaborators[d.task_id].find((c) => c.agent_id === d.agent_id);
        if (!existing) {
          state.collaborators[d.task_id].push({
            task_id: d.task_id,
            agent_id: d.agent_id,
            role: d.role || 'collaborator',
          });
        }
      }
      break;
    }
    case 'collaborator:removed': {
      if (d.task_id && d.agent_id && state.collaborators[d.task_id]) {
        state.collaborators[d.task_id] = state.collaborators[d.task_id].filter(
          (c) => c.agent_id !== d.agent_id,
        );
      }
      break;
    }
  }

  render();

  if (state.panelTaskId) {
    var updated = d.task && d.task.id === state.panelTaskId;
    if (updated || event.type === 'artifact:created' || event.type === 'comment:created') {
      openPanel(state.panelTaskId);
    }
  }
}

// ---- Legacy Modal (cleanup only) ----

function closeModal() {
  TaskBoard._root.getElementById('task-modal').hidden = true;
}

// ---- Init ----

function _init() {
  var savedTheme = localStorage.getItem('agent-tasks-theme');
  if (savedTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  updateThemeIcon(savedTheme || 'light');

  TaskBoard._root.getElementById('theme-toggle')?.addEventListener('click', () => {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var next = isDark ? 'light' : 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    localStorage.setItem('agent-tasks-theme', next);
    updateThemeIcon(next);
  });

  TaskBoard._root.getElementById('filter-search')?.addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      filters.search = e.target.value;
      saveFilters();
      TaskBoard.resetColumnVisibleCounts();
      render();
    }, 200);
  });

  TaskBoard._root.getElementById('filter-project')?.addEventListener('change', (e) => {
    filters.project = e.target.value;
    saveFilters();
    TaskBoard.resetColumnVisibleCounts();
    render();
  });

  TaskBoard._root.getElementById('filter-assignee')?.addEventListener('change', (e) => {
    filters.assignee = e.target.value;
    saveFilters();
    TaskBoard.resetColumnVisibleCounts();
    render();
  });

  TaskBoard._root.getElementById('filter-priority')?.addEventListener('change', (e) => {
    filters.minPriority = parseInt(e.target.value) || 0;
    saveFilters();
    TaskBoard.resetColumnVisibleCounts();
    render();
  });

  // ---- Event Delegation (board) ----

  TaskBoard._root.getElementById('board')?.addEventListener('click', (e) => {
    var action = e.target.closest('[data-action]');

    if (action) {
      var act = action.dataset.action;

      if (act === 'toggle-collapse') {
        e.stopPropagation();
        var stage = action.dataset.stage;
        if (state.collapsedColumns.has(stage)) {
          state.collapsedColumns.delete(stage);
        } else {
          state.collapsedColumns.add(stage);
        }
        saveCollapsed();
        render();
        return;
      }

      if (act === 'inline-create') {
        e.stopPropagation();
        TaskBoard.showInlineCreate(action.dataset.stage);
        return;
      }

      if (act === 'add-task') {
        e.stopPropagation();
        TaskBoard.showInlineCreate(action.dataset.stage);
        return;
      }

      if (act === 'cycle-priority') {
        e.stopPropagation();
        TaskBoard.cyclePriority(parseInt(action.dataset.taskId, 10));
        return;
      }

      if (act === 'change-assignee') {
        e.stopPropagation();
        TaskBoard.showAssigneeDropdown(parseInt(action.dataset.taskId, 10), action);
        return;
      }

      if (act === 'show-more') {
        e.stopPropagation();
        TaskBoard.showMoreCards(action.dataset.stage);
        render();
        return;
      }
    }

    var card = e.target.closest('.task-card[data-task-id]');
    if (card) {
      TaskBoard.openPanel(parseInt(card.dataset.taskId, 10));
    }
  });

  TaskBoard._root.getElementById('board')?.addEventListener('dblclick', (e) => {
    var titleEl = e.target.closest('[data-action="edit-title"]');
    if (titleEl) {
      e.stopPropagation();
      TaskBoard.startInlineEdit(titleEl);
    }
  });

  TaskBoard._root.getElementById('board')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      var card = e.target.closest('.task-card[data-task-id]');
      if (card) TaskBoard.openPanel(parseInt(card.dataset.taskId, 10));
    }
  });

  // ---- Collapsed column click (expand) ----

  TaskBoard._root.getElementById('board')?.addEventListener('click', (e) => {
    var col = e.target.closest('.kanban-column.collapsed');
    if (col) {
      var stage = col.dataset.stage;
      state.collapsedColumns.delete(stage);
      saveCollapsed();
      render();
    }
  });

  TaskBoard._root.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
  TaskBoard._root.getElementById('task-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  // ---- Keyboard Navigation ----

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (TaskBoard.getActiveDropdown()) {
        TaskBoard.dismissDropdown();
        return;
      }
      if (TaskBoard.getActiveInlineCreate()) {
        TaskBoard.dismissInlineCreate();
        return;
      }
      if (state.panelTaskId) {
        TaskBoard.closePanel();
        return;
      }
      var modal = TaskBoard._root.getElementById('task-modal');
      if (modal && !modal.hidden) {
        closeModal();
        return;
      }
      var cleanupModal = TaskBoard._root.getElementById('cleanup-modal');
      if (cleanupModal && !cleanupModal.classList.contains('hidden')) {
        cleanupModal.classList.add('hidden');
        return;
      }
    }

    var isInput =
      document.activeElement?.tagName === 'INPUT' ||
      document.activeElement?.tagName === 'TEXTAREA' ||
      document.activeElement?.getAttribute('contenteditable') === 'true';

    if (
      (e.key === '/' && !e.ctrlKey && !e.metaKey && !isInput) ||
      ((e.ctrlKey || e.metaKey) && e.key === 'k')
    ) {
      e.preventDefault();
      TaskBoard._root.getElementById('filter-search')?.focus();
    }
  });

  // ---- Cleanup Dialog ----

  TaskBoard._root.getElementById('cleanup-btn')?.addEventListener('click', () => {
    TaskBoard._root.getElementById('cleanup-modal').classList.remove('hidden');
  });

  TaskBoard._root.getElementById('cleanup-close-btn')?.addEventListener('click', () => {
    TaskBoard._root.getElementById('cleanup-modal').classList.add('hidden');
  });

  TaskBoard._root.getElementById('cleanup-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      TaskBoard._root.getElementById('cleanup-modal').classList.add('hidden');
    }
  });

  TaskBoard._root.getElementById('cleanup-completed')?.addEventListener('click', () => {
    var showToast = TaskBoard.showToast;
    TaskBoard._root.getElementById('cleanup-modal').classList.add('hidden');
    TaskBoard._fetch('/api/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    })
      .then((r) => r.json())
      .then((result) => {
        showToast(
          'Cleanup complete',
          `Purged ${result.purgedTasks} tasks, ${result.purgedComments} comments, ${result.purgedApprovals} approvals`,
          'success',
        );
      })
      .catch(() => showToast('Cleanup failed', 'Network error', 'error'));
  });

  TaskBoard._root.getElementById('cleanup-everything')?.addEventListener('click', () => {
    var showToast = TaskBoard.showToast;
    if (
      !confirm(
        'This will remove ALL tasks — completed, in-progress, everything. This cannot be undone. Continue?',
      )
    )
      return;
    TaskBoard._root.getElementById('cleanup-modal').classList.add('hidden');
    TaskBoard._fetch('/api/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
      .then((r) => r.json())
      .then((result) => {
        showToast(
          'Everything purged',
          `Purged ${result.purgedTasks} tasks, ${result.purgedComments} comments, ${result.purgedApprovals} approvals`,
          'success',
        );
      })
      .catch(() => showToast('Cleanup failed', 'Network error', 'error'));
  });

  // ---- Theme sync from parent (agent-desk) via executeJavaScript ----

  window.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'theme-sync') return;
    var colors = event.data.colors;
    if (!colors) return;

    function ensureContrast(bg, fg) {
      var lum = function (hex) {
        if (!hex || hex.charAt(0) !== '#' || hex.length < 7) return 0.5;
        var r = parseInt(hex.slice(1, 3), 16) / 255;
        var g = parseInt(hex.slice(3, 5), 16) / 255;
        var b = parseInt(hex.slice(5, 7), 16) / 255;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      var bgLum = lum(bg);
      return bgLum < 0.5 ? (lum(fg) < 0.4 ? '#e0e0e0' : fg) : lum(fg) > 0.6 ? '#333333' : fg;
    }

    var root = document.documentElement;
    var bgColor = colors.bg || null;

    if (colors.bg) root.style.setProperty('--bg', colors.bg);
    if (colors.bgSurface) root.style.setProperty('--bg-surface', colors.bgSurface);
    if (colors.bgElevated) root.style.setProperty('--bg-elevated', colors.bgElevated);
    if (colors.bgHover) root.style.setProperty('--bg-hover', colors.bgHover);
    if (colors.bgInset) root.style.setProperty('--bg-inset', colors.bgInset);

    if (colors.border) root.style.setProperty('--border', colors.border);
    if (colors.borderLight) root.style.setProperty('--border-light', colors.borderLight);

    if (colors.text)
      root.style.setProperty(
        '--text',
        bgColor ? ensureContrast(bgColor, colors.text) : colors.text,
      );
    if (colors.textSecondary)
      root.style.setProperty(
        '--text-secondary',
        bgColor ? ensureContrast(bgColor, colors.textSecondary) : colors.textSecondary,
      );
    if (colors.textMuted)
      root.style.setProperty(
        '--text-muted',
        bgColor ? ensureContrast(bgColor, colors.textMuted) : colors.textMuted,
      );
    if (colors.textDim)
      root.style.setProperty(
        '--text-dim',
        bgColor ? ensureContrast(bgColor, colors.textDim) : colors.textDim,
      );

    if (colors.accent) root.style.setProperty('--accent', colors.accent);
    if (colors.accentHover) root.style.setProperty('--accent-hover', colors.accentHover);
    if (colors.accentDim) root.style.setProperty('--accent-dim', colors.accentDim);
    if (colors.accentSolid) root.style.setProperty('--accent-solid', colors.accentSolid);
    if (colors.accentGlow) root.style.setProperty('--accent-glow', colors.accentGlow);

    if (colors.green) root.style.setProperty('--green', colors.green);
    if (colors.greenDim) root.style.setProperty('--green-dim', colors.greenDim);
    if (colors.yellow) root.style.setProperty('--yellow', colors.yellow);
    if (colors.yellowDim) root.style.setProperty('--yellow-dim', colors.yellowDim);
    if (colors.orange) root.style.setProperty('--orange', colors.orange);
    if (colors.orangeDim) root.style.setProperty('--orange-dim', colors.orangeDim);
    if (colors.red) root.style.setProperty('--red', colors.red);
    if (colors.redDim) root.style.setProperty('--red-dim', colors.redDim);
    if (colors.purple) root.style.setProperty('--purple', colors.purple);
    if (colors.purpleDim) root.style.setProperty('--purple-dim', colors.purpleDim);
    if (colors.blue) root.style.setProperty('--blue', colors.blue);
    if (colors.blueDim) root.style.setProperty('--blue-dim', colors.blueDim);
    if (colors.indigo) root.style.setProperty('--indigo', colors.indigo);
    if (colors.indigoDim) root.style.setProperty('--indigo-dim', colors.indigoDim);
    if (colors.amber) root.style.setProperty('--amber', colors.amber);
    if (colors.amberDim) root.style.setProperty('--amber-dim', colors.amberDim);
    if (colors.gray) root.style.setProperty('--gray', colors.gray);
    if (colors.grayDim) root.style.setProperty('--gray-dim', colors.grayDim);

    if (colors.stageBacklog) root.style.setProperty('--stage-backlog', colors.stageBacklog);
    if (colors.stageSpec) root.style.setProperty('--stage-spec', colors.stageSpec);
    if (colors.stagePlan) root.style.setProperty('--stage-plan', colors.stagePlan);
    if (colors.stageImplement) root.style.setProperty('--stage-implement', colors.stageImplement);
    if (colors.stageTest) root.style.setProperty('--stage-test', colors.stageTest);
    if (colors.stageReview) root.style.setProperty('--stage-review', colors.stageReview);
    if (colors.stageDone) root.style.setProperty('--stage-done', colors.stageDone);
    if (colors.stageCancelled) root.style.setProperty('--stage-cancelled', colors.stageCancelled);

    if (colors.focusRing) root.style.setProperty('--focus-ring', colors.focusRing);

    if (colors.isDark !== undefined) {
      if (colors.isDark) {
        root.style.setProperty(
          '--shadow-1',
          '0px 1px 2px 0px rgba(0,0,0,0.6), 0px 1px 3px 1px rgba(0,0,0,0.3)',
        );
        root.style.setProperty(
          '--shadow-2',
          '0px 1px 2px 0px rgba(0,0,0,0.6), 0px 2px 6px 2px rgba(0,0,0,0.3)',
        );
        root.style.setProperty(
          '--shadow-3',
          '0px 1px 3px 0px rgba(0,0,0,0.6), 0px 4px 8px 3px rgba(0,0,0,0.3)',
        );
        root.style.setProperty(
          '--shadow-hover',
          '0px 2px 4px 0px rgba(0,0,0,0.5), 0px 6px 16px 4px rgba(0,0,0,0.4)',
        );
        root.style.setProperty(
          '--shadow-drag',
          '0px 4px 8px 0px rgba(0,0,0,0.5), 0px 12px 32px 6px rgba(0,0,0,0.4)',
        );
        root.style.setProperty(
          '--shadow-panel',
          '-2px 0px 8px 0px rgba(0,0,0,0.5), -4px 0px 16px 2px rgba(0,0,0,0.3)',
        );
      } else {
        root.style.setProperty(
          '--shadow-1',
          '0px 1px 2px 0px rgba(0,0,0,0.3), 0px 1px 3px 1px rgba(0,0,0,0.15)',
        );
        root.style.setProperty(
          '--shadow-2',
          '0px 1px 2px 0px rgba(0,0,0,0.3), 0px 2px 6px 2px rgba(0,0,0,0.15)',
        );
        root.style.setProperty(
          '--shadow-3',
          '0px 1px 3px 0px rgba(0,0,0,0.3), 0px 4px 8px 3px rgba(0,0,0,0.15)',
        );
        root.style.setProperty(
          '--shadow-hover',
          '0px 2px 4px 0px rgba(0,0,0,0.25), 0px 4px 12px 4px rgba(0,0,0,0.15)',
        );
        root.style.setProperty(
          '--shadow-drag',
          '0px 4px 8px 0px rgba(0,0,0,0.3), 0px 12px 32px 6px rgba(0,0,0,0.25)',
        );
        root.style.setProperty(
          '--shadow-panel',
          '-2px 0px 8px 0px rgba(0,0,0,0.3), -4px 0px 16px 2px rgba(0,0,0,0.15)',
        );
      }
    }

    if (colors.isDark !== undefined) {
      var theme = colors.isDark ? 'dark' : 'light';
      if (colors.isDark) {
        document.documentElement.setAttribute('data-theme', 'dark');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
      localStorage.setItem('agent-tasks-theme', theme);
      updateThemeIcon(theme);
    }

    var themeToggle = TaskBoard._root.getElementById('theme-toggle');
    if (themeToggle) themeToggle.style.display = 'none';
  });

  // ---- Initialize modules ----

  TaskBoard.initDragEvents();
  TaskBoard.initPanelEvents();
  TaskBoard.initPanelResize();

  // ---- Boot ----

  connect();
}

// ---- Plugin mount/unmount ----

TaskBoard.mount = function (container, options) {
  options = options || {};
  TaskBoard._baseUrl = options.baseUrl || '';
  TaskBoard._wsUrl = options.wsUrl || null;

  var shadow = container.attachShadow({ mode: 'open' });

  if (options.cssUrl) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = options.cssUrl;
    shadow.appendChild(link);
  }

  var fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href =
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap';
  shadow.appendChild(fonts);
  var icons = document.createElement('link');
  icons.rel = 'stylesheet';
  icons.href =
    'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap';
  shadow.appendChild(icons);

  var pluginStyle = document.createElement('style');
  pluginStyle.textContent =
    ':host { display:block; width:100%; height:100%; overflow:hidden; }' +
    '.tb-wrapper { font-family:var(--font-sans); font-size:14px; color:var(--text); background:var(--bg); line-height:1.5; width:100%; height:100%; overflow:hidden; display:flex; flex-direction:column; }';
  shadow.appendChild(pluginStyle);

  if (typeof TaskBoard._template === 'function') {
    var wrapper = document.createElement('div');
    wrapper.className = 'tb-wrapper';
    wrapper.setAttribute('data-theme', 'dark');
    wrapper.innerHTML = TaskBoard._template();
    shadow.appendChild(wrapper);
  }

  TaskBoard._root = shadow;
  _init();
};

TaskBoard.unmount = function () {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  clearTimeout(reconnectTimer);
  TaskBoard._root = document;
};

// ---- Auto-init — check URL params for embedded mode (iframe in agent-desk) ----

var _params = new URLSearchParams(location.search);
if (_params.get('baseUrl')) TaskBoard._baseUrl = _params.get('baseUrl');
if (_params.get('wsUrl')) TaskBoard._wsUrl = _params.get('wsUrl');
try {
  _init();
} catch (e) {
  /* standalone init may fail in file:// context — plugin mode uses mount() */
}
