// =============================================================================
// agent-tasks — Pipeline dashboard client
//
// Kanban board with real-time WebSocket updates, drag-and-drop,
// filters, comments, subtask progress, and keyboard navigation.
// =============================================================================

// ---- State ----

const state = {
  tasks: [],
  dependencies: [],
  artifactCounts: {},
  commentCounts: {},
  subtaskProgress: {},
  stages: ['backlog', 'spec', 'plan', 'implement', 'test', 'review', 'done', 'cancelled'],
};

const filters = {
  search: '',
  project: '',
  assignee: '',
  minPriority: 0,
};

let ws = null;
let reconnectTimer = null;
let searchDebounce = null;
let draggedTaskId = null;
let lastOpenedCardEl = null;

// Restore filters from localStorage
try {
  const saved = JSON.parse(localStorage.getItem('agent-tasks-filters') || '{}');
  if (saved.search) filters.search = saved.search;
  if (saved.project) filters.project = saved.project;
  if (saved.assignee) filters.assignee = saved.assignee;
  if (saved.minPriority) filters.minPriority = saved.minPriority;
} catch {
  /* ignore */
}

function saveFilters() {
  localStorage.setItem('agent-tasks-filters', JSON.stringify(filters));
}

// ---- Theme ----

function updateThemeIcon(theme) {
  const icon = document.querySelector('.theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
}

const savedTheme = localStorage.getItem('agent-tasks-theme');
if (savedTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
updateThemeIcon(savedTheme || 'light');

document.getElementById('theme-toggle').addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
  localStorage.setItem('agent-tasks-theme', next);
  updateThemeIcon(next);
});

// ---- WebSocket ----

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
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
  const el = document.getElementById('connection-status');
  el.textContent =
    status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting' : 'Disconnected';
  el.className = 'status-badge ' + status;
}

// ---- State handlers ----

// Fingerprint cache: skip re-renders when data hasn't changed
let _lastStateFingerprint = '';

function handleFullState(data) {
  // Build a fingerprint from the incoming data to detect actual changes
  const fp = quickFingerprint(data);
  if (fp === _lastStateFingerprint) return; // nothing changed — skip render
  _lastStateFingerprint = fp;

  state.tasks = data.tasks || [];
  state.dependencies = data.dependencies || [];
  state.artifactCounts = data.artifactCounts || {};
  state.commentCounts = data.commentCounts || {};
  state.subtaskProgress = data.subtaskProgress || {};
  if (data.stages) state.stages = data.stages;
  if (data.version) {
    document.getElementById('version').textContent = 'v' + data.version;
  }
  updateFilterDropdowns();
  applyRestoredFilters();
  render();
  dismissLoading();
}

/** Fast fingerprint: hash task count, IDs, stages, updated_at timestamps.
 *  Avoids JSON.stringify of the full payload (which can be large). */
function quickFingerprint(data) {
  const tasks = data.tasks || [];
  // Combine: task count + each task's id:stage:status:updated_at:priority + dependency count
  let fp = tasks.length + ':';
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    fp += t.id + '.' + t.stage + '.' + t.status + '.' + (t.updated_at || '') + '.' + t.priority + ',';
  }
  fp += '|' + (data.dependencies || []).length;
  fp += '|' + JSON.stringify(data.artifactCounts || {});
  fp += '|' + JSON.stringify(data.commentCounts || {});
  fp += '|' + JSON.stringify(data.subtaskProgress || {});
  return fp;
}

function dismissLoading() {
  const overlay = document.getElementById('loading-overlay');
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

function applyRestoredFilters() {
  const searchInput = document.getElementById('filter-search');
  if (filters.search && searchInput) searchInput.value = filters.search;
  const projectSelect = document.getElementById('filter-project');
  if (filters.project && projectSelect) projectSelect.value = filters.project;
  const assigneeSelect = document.getElementById('filter-assignee');
  if (filters.assignee && assigneeSelect) assigneeSelect.value = filters.assignee;
  const prioritySelect = document.getElementById('filter-priority');
  if (filters.minPriority && prioritySelect) prioritySelect.value = String(filters.minPriority);
}

function handleEvent(event) {
  const d = event.data || {};

  switch (event.type) {
    case 'task:created': {
      if (d.task) state.tasks.unshift(d.task);
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
        const idx = state.tasks.findIndex((t) => t.id === d.task.id);
        if (idx >= 0) state.tasks[idx] = d.task;
        else state.tasks.unshift(d.task);
      }
      break;
    }
    case 'task:deleted': {
      if (d.task) {
        state.tasks = state.tasks.filter((t) => t.id !== d.task.id);
      }
      break;
    }
    case 'artifact:created': {
      if (d.artifact) {
        const tid = d.artifact.task_id;
        state.artifactCounts[tid] = (state.artifactCounts[tid] || 0) + 1;
      }
      break;
    }
    case 'comment:created': {
      if (d.comment) {
        const tid = d.comment.task_id;
        state.commentCounts[tid] = (state.commentCounts[tid] || 0) + 1;
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
  }

  render();
}

// ---- Filters ----

function getFilteredTasks() {
  return state.tasks.filter((t) => {
    if (filters.project && t.project !== filters.project) return false;
    if (filters.assignee && t.assigned_to !== filters.assignee) return false;
    if (filters.minPriority && t.priority < filters.minPriority) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const inTitle = t.title.toLowerCase().includes(q);
      const inDesc = (t.description || '').toLowerCase().includes(q);
      const inId = `#${t.id}`.includes(q);
      if (!inTitle && !inDesc && !inId) return false;
    }
    return true;
  });
}

function updateFilterDropdowns() {
  const projects = [...new Set(state.tasks.map((t) => t.project).filter(Boolean))].sort();
  const assignees = [...new Set(state.tasks.map((t) => t.assigned_to).filter(Boolean))].sort();

  const projectSelect = document.getElementById('filter-project');
  const currentProject = projectSelect.value;
  projectSelect.innerHTML =
    '<option value="">All projects</option>' +
    projects.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  projectSelect.value = currentProject;

  const assigneeSelect = document.getElementById('filter-assignee');
  const currentAssignee = assigneeSelect.value;
  assigneeSelect.innerHTML =
    '<option value="">All assignees</option>' +
    assignees.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
  assigneeSelect.value = currentAssignee;
}

document.getElementById('filter-search').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    filters.search = e.target.value;
    saveFilters();
    render();
  }, 200);
});

document.getElementById('filter-project').addEventListener('change', (e) => {
  filters.project = e.target.value;
  saveFilters();
  render();
});

document.getElementById('filter-assignee').addEventListener('change', (e) => {
  filters.assignee = e.target.value;
  saveFilters();
  render();
});

document.getElementById('filter-priority').addEventListener('change', (e) => {
  filters.minPriority = parseInt(e.target.value) || 0;
  saveFilters();
  render();
});

// ---- Blocked tasks ----

function getBlockedTaskIds() {
  const blocked = new Set();
  const doneOrCancelled = new Set(
    state.tasks.filter((t) => t.stage === 'done' || t.stage === 'cancelled').map((t) => t.id),
  );
  for (const dep of state.dependencies) {
    if (!doneOrCancelled.has(dep.depends_on)) {
      blocked.add(dep.task_id);
    }
  }
  return blocked;
}

// ---- Rendering ----

function render() {
  renderBoard();
  renderStats();
}

function renderStats() {
  const total = state.tasks.length;
  const active = state.tasks.filter((t) => t.status === 'in_progress').length;
  const pending = state.tasks.filter((t) => t.status === 'pending').length;
  const done = state.tasks.filter((t) => t.status === 'completed').length;

  document.getElementById('stats').innerHTML =
    `<span class="stat">Total <span class="stat-value">${total}</span></span>` +
    `<span class="stat">Active <span class="stat-value">${active}</span></span>` +
    `<span class="stat">Pending <span class="stat-value">${pending}</span></span>` +
    `<span class="stat">Done <span class="stat-value">${done}</span></span>`;
}

function renderBoard() {
  const board = document.getElementById('board');
  const blocked = getBlockedTaskIds();
  const filtered = getFilteredTasks();
  const visibleStages = state.stages.filter((s) => s !== 'cancelled');

  if (state.tasks.length === 0) {
    board.innerHTML = `
      <div class="board-empty">
        <span class="material-symbols-outlined">assignment</span>
        <h3>No tasks yet</h3>
        <p>Create tasks via MCP tools (task_create) or the REST API (POST /api/tasks)</p>
      </div>`;
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

  board.innerHTML = columnsToShow
    .map((stage) => {
      const tasks = byStage[stage] || [];
      return `
      <div class="kanban-column" data-stage="${esc(stage)}">
        <div class="column-header" role="tablist">
          <h3>${esc(stage)}</h3>
          <span class="column-count" aria-label="${tasks.length} tasks">${tasks.length}</span>
        </div>
        <div class="column-body" role="tabpanel" aria-label="${esc(stage)} tasks">
          ${tasks.map((t) => renderCard(t, blocked.has(t.id))).join('')}
        </div>
      </div>`;
    })
    .join('');
}

function renderCard(task, isBlocked) {
  const tags = [];

  if (task.project) {
    tags.push(`<span class="task-tag tag-project">${esc(task.project)}</span>`);
  }
  if (task.assigned_to) {
    tags.push(`<span class="task-tag tag-assignee">${esc(task.assigned_to)}</span>`);
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
    task.priority >= 5
      ? ' priority-high'
      : task.priority >= 3
        ? ' priority-medium'
        : task.priority >= 1
          ? ' priority-low'
          : '';

  return `
    <div class="task-card${priorityClass}" tabindex="0" draggable="true"
         data-task-id="${task.id}"
         role="button"
         aria-label="Task #${task.id}: ${esc(task.title)}">
      <div class="task-card-id">#${task.id}</div>
      <div class="task-card-title">${esc(task.title)}</div>
      ${tags.length ? `<div class="task-card-meta">${tags.join('')}</div>` : ''}
      ${progressBar}
    </div>`;
}

// ---- Event Delegation (replaces inline handlers) ----

document.getElementById('board').addEventListener('click', (e) => {
  const card = e.target.closest('.task-card[data-task-id]');
  if (card) {
    openTask(parseInt(card.dataset.taskId, 10));
  }
});

document.getElementById('board').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const card = e.target.closest('.task-card[data-task-id]');
    if (card) openTask(parseInt(card.dataset.taskId, 10));
  }
});

document.getElementById('board').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.task-card[data-task-id]');
  if (card) onDragStart(e, parseInt(card.dataset.taskId, 10));
});

document.getElementById('board').addEventListener('dragend', (e) => {
  onDragEnd(e);
});

document.getElementById('board').addEventListener('dragover', (e) => {
  const col = e.target.closest('.kanban-column');
  if (col) onDragOver(e, col);
});

document.getElementById('board').addEventListener('dragleave', (e) => {
  const col = e.target.closest('.kanban-column');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
});

document.getElementById('board').addEventListener('drop', (e) => {
  const col = e.target.closest('.kanban-column');
  if (col) onDrop(e, col);
});

// Delegation for modal subtask links and comment button
document.getElementById('modal-body')?.addEventListener('click', (e) => {
  const subtask = e.target.closest('[data-subtask-id]');
  if (subtask) {
    openTask(parseInt(subtask.dataset.subtaskId, 10));
    return;
  }
  const sendBtn = e.target.closest('#comment-send-btn');
  if (sendBtn) {
    submitComment(parseInt(sendBtn.dataset.taskId, 10));
  }
});

// ---- Drag and Drop ----

function onDragStart(e, taskId) {
  draggedTaskId = taskId;
  e.dataTransfer.effectAllowed = 'move';
  const card = e.target.closest('.task-card');
  if (card) card.classList.add('dragging');
}

function onDragEnd(e) {
  const card = e.target.closest('.task-card');
  if (card) card.classList.remove('dragging');
  draggedTaskId = null;
  document
    .querySelectorAll('.kanban-column.drag-over')
    .forEach((c) => c.classList.remove('drag-over'));
}

function onDragOver(e, col) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (col && !col.classList.contains('drag-over')) {
    col.classList.add('drag-over');
  }
}

function onDragLeave(e) {
  const col = e.target.closest('.kanban-column');
  if (col && !col.contains(e.relatedTarget)) {
    col.classList.remove('drag-over');
  }
}

function onDrop(e, col) {
  e.preventDefault();
  if (col) col.classList.remove('drag-over');

  if (!draggedTaskId) return;
  const targetStage = col.dataset.stage;
  const task = state.tasks.find((t) => t.id === draggedTaskId);
  if (!task || task.stage === targetStage) return;

  fetch(`/api/tasks/${draggedTaskId}/stage`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage: targetStage }),
  })
    .then((r) => r.json())
    .then((result) => {
      if (result.error) {
        showToast('Move failed', result.error, 'error');
      }
    })
    .catch(() => showToast('Move failed', 'Network error', 'error'));
}

// ---- Modal ----

function openTask(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;

  lastOpenedCardEl = document.querySelector(`[data-task-id="${id}"]`);
  document.getElementById('modal-title').textContent = `#${task.id} — ${task.title}`;

  const deps = state.dependencies.filter((d) => d.task_id === task.id);
  const blocking = state.dependencies.filter((d) => d.depends_on === task.id);

  let html = '<div class="detail-rows">';

  const rows = [
    ['Status', task.status],
    ['Stage', task.stage],
    ['Priority', task.priority],
    ['Created by', task.created_by],
    ['Assigned to', task.assigned_to || '\u2014'],
    ['Project', task.project || '\u2014'],
    ['Created', formatDate(task.created_at)],
    ['Updated', formatDate(task.updated_at)],
  ];

  if (task.parent_id) {
    const parent = state.tasks.find((t) => t.id === task.parent_id);
    rows.push(['Parent', parent ? `#${parent.id} ${parent.title}` : `#${task.parent_id}`]);
  }

  if (task.tags) {
    try {
      const parsed = JSON.parse(task.tags);
      if (Array.isArray(parsed) && parsed.length) {
        rows.push(['Tags', parsed.join(', ')]);
      }
    } catch {
      /* ignore */
    }
  }

  if (task.description) {
    rows.push(['Description', task.description]);
  }
  if (task.result) {
    rows.push(['Result', task.result]);
  }

  for (const [label, value] of rows) {
    html += `<div class="detail-row"><span class="detail-label">${esc(label)}</span><span class="detail-value">${esc(String(value))}</span></div>`;
  }

  if (deps.length) {
    const depNames = deps.map((d) => {
      const t = state.tasks.find((x) => x.id === d.depends_on);
      return t ? `#${t.id} ${t.title}` : `#${d.depends_on}`;
    });
    html += `<div class="detail-row"><span class="detail-label">Depends on</span><span class="detail-value">${depNames.map(esc).join('<br>')}</span></div>`;
  }

  if (blocking.length) {
    const blockNames = blocking.map((d) => {
      const t = state.tasks.find((x) => x.id === d.task_id);
      return t ? `#${t.id} ${t.title}` : `#${d.task_id}`;
    });
    html += `<div class="detail-row"><span class="detail-label">Blocks</span><span class="detail-value">${blockNames.map(esc).join('<br>')}</span></div>`;
  }

  html += '</div>';

  const modalBody = document.getElementById('modal-body');
  modalBody.innerHTML = html;
  document.getElementById('task-modal').hidden = false;
  const closeBtn = document.getElementById('modal-close-btn');
  if (closeBtn) closeBtn.focus();

  Promise.all([
    fetch(`/api/tasks/${task.id}/artifacts`)
      .then((r) => r.json())
      .catch(() => []),
    fetch(`/api/tasks/${task.id}/comments`)
      .then((r) => r.json())
      .catch(() => []),
    fetch(`/api/tasks/${task.id}/subtasks`)
      .then((r) => r.json())
      .catch(() => []),
  ]).then(([artifacts, comments, subtasks]) => {
    let extra = '';

    if (subtasks.length) {
      extra +=
        '<div class="artifact-list"><h3 style="margin-bottom:8px;font-size:13px;">Subtasks</h3>';
      for (const s of subtasks) {
        extra += `<div class="artifact-item subtask-link" style="cursor:pointer" data-subtask-id="${s.id}">
          <h4>#${s.id} ${esc(s.title)} <span style="color:var(--text-dim);font-weight:400">(${esc(s.stage)})</span></h4>
        </div>`;
      }
      extra += '</div>';
    }

    if (artifacts.length) {
      extra +=
        '<div class="artifact-list"><h3 style="margin-bottom:8px;font-size:13px;">Artifacts</h3>';
      for (const a of artifacts) {
        const vLabel = a.version > 1 ? ` v${a.version}` : '';
        extra += `<div class="artifact-item">
          <h4>${esc(a.name)}${vLabel} <span style="color:var(--text-dim);font-weight:400">(${esc(a.stage)}, ${esc(a.created_by)})</span></h4>
          <pre>${esc(a.content)}</pre>
        </div>`;
      }
      extra += '</div>';
    }

    if (comments.length || true) {
      extra += `<div class="comments-section">
        <h3><span class="material-symbols-outlined" style="font-size:16px">chat</span> Comments (${comments.length})</h3>`;
      for (const c of comments) {
        const isReply = c.parent_comment_id ? ' reply' : '';
        extra += `<div class="comment-item${isReply}">
          <div class="comment-header">
            <span class="comment-agent">${esc(c.agent_id)}</span>
            <span class="comment-time">${formatDate(c.created_at)}</span>
          </div>
          <div class="comment-body">${esc(c.content)}</div>
        </div>`;
      }
      extra += `<div class="comment-form">
        <textarea id="comment-input" placeholder="Add a comment..." rows="1" aria-label="Add a comment"></textarea>
        <button id="comment-send-btn" data-task-id="${task.id}" aria-label="Send comment">Send</button>
      </div></div>`;
    }

    modalBody.innerHTML = html + extra;
  });
}

function submitComment(taskId) {
  const input = document.getElementById('comment-input');
  const content = input?.value?.trim();
  if (!content) return;

  fetch(`/api/tasks/${taskId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, agent_id: 'dashboard' }),
  })
    .then((r) => r.json())
    .then(() => {
      openTask(taskId);
    })
    .catch(() => showToast('Error', 'Failed to post comment', 'error'));
}

function closeModal() {
  document.getElementById('task-modal').hidden = true;
  if (lastOpenedCardEl) {
    lastOpenedCardEl.focus();
    lastOpenedCardEl = null;
  }
}

// ---- Focus Trap (modal) ----

function getFocusableElements(container) {
  return container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
}

document.getElementById('task-modal').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const modal = document.querySelector('#task-modal .modal');
  if (!modal) return;
  const focusable = getFocusableElements(modal);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
document.getElementById('task-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

// ---- Keyboard Navigation ----

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('task-modal');
    if (!modal.hidden) {
      closeModal();
      return;
    }
  }
  const isInput =
    document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
  if (
    (e.key === '/' && !e.ctrlKey && !e.metaKey && !isInput) ||
    ((e.ctrlKey || e.metaKey) && e.key === 'k')
  ) {
    e.preventDefault();
    document.getElementById('filter-search').focus();
  }
});

// ---- Toast ----

function showToast(title, body, type) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';

  const isError =
    type === 'error' ||
    title.toLowerCase().includes('fail') ||
    title.toLowerCase().includes('error');
  const iconName = isError ? 'error' : 'check_circle';
  const iconClass = isError ? 'toast-icon-error' : 'toast-icon-success';

  el.innerHTML =
    `<span class="material-symbols-outlined toast-icon ${iconClass}" aria-hidden="true">${iconName}</span>` +
    `<div class="toast-content"><div class="toast-title">${esc(title)}</div><div class="toast-body">${esc(body)}</div></div>`;
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('fade-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, 4000);
}

// ---- Helpers ----

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '\u2014';
  try {
    const d = new Date(iso + 'Z');
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ---- Cleanup Dialog ----

document.getElementById('cleanup-btn')?.addEventListener('click', () => {
  document.getElementById('cleanup-modal').classList.remove('hidden');
});

document.getElementById('cleanup-close-btn')?.addEventListener('click', () => {
  document.getElementById('cleanup-modal').classList.add('hidden');
});

document.getElementById('cleanup-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('cleanup-modal').classList.add('hidden');
  }
});

document.getElementById('cleanup-completed')?.addEventListener('click', () => {
  document.getElementById('cleanup-modal').classList.add('hidden');
  fetch('/api/cleanup', { method: 'POST' })
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

document.getElementById('cleanup-all')?.addEventListener('click', () => {
  if (!confirm('This will remove ALL completed and cancelled tasks. Continue?')) return;
  document.getElementById('cleanup-modal').classList.add('hidden');
  fetch('/api/cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: true }),
  })
    .then((r) => r.json())
    .then((result) => {
      showToast(
        'Full cleanup complete',
        `Purged ${result.purgedTasks} tasks, ${result.purgedComments} comments, ${result.purgedApprovals} approvals`,
        'success',
      );
    })
    .catch(() => showToast('Cleanup failed', 'Network error', 'error'));
});

// ---- Boot ----

connect();
