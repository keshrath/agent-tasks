// =============================================================================
// agent-tasks — Pipeline dashboard client
//
// Kanban board with real-time WebSocket updates.
// =============================================================================

// ---- State ----

const state = {
  tasks: [],
  dependencies: [],
  artifactCounts: {},
  stages: ['backlog', 'spec', 'plan', 'implement', 'test', 'review', 'done', 'cancelled'],
};

let ws = null;
let reconnectTimer = null;

// ---- Theme ----

const savedTheme = localStorage.getItem('agent-tasks-theme');
if (savedTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');

document.getElementById('theme-toggle').addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('agent-tasks-theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('agent-tasks-theme', 'dark');
  }
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

function handleFullState(data) {
  state.tasks = data.tasks || [];
  state.dependencies = data.dependencies || [];
  state.artifactCounts = data.artifactCounts || {};
  if (data.stages) state.stages = data.stages;
  if (data.version) {
    document.getElementById('version').textContent = 'v' + data.version;
  }
  render();
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
  const visibleStages = state.stages.filter((s) => s !== 'cancelled');

  // Group tasks by stage
  const byStage = {};
  for (const s of state.stages) byStage[s] = [];
  for (const t of state.tasks) {
    if (byStage[t.stage]) byStage[t.stage].push(t);
    else byStage[t.stage] = [t];
  }

  // Sort by priority desc within each column
  for (const s of Object.keys(byStage)) {
    byStage[s].sort((a, b) => b.priority - a.priority);
  }

  // Include cancelled column only if there are cancelled tasks
  const columnsToShow = [...visibleStages];
  if (byStage['cancelled']?.length > 0 && !columnsToShow.includes('cancelled')) {
    columnsToShow.push('cancelled');
  }

  board.innerHTML = columnsToShow
    .map((stage) => {
      const tasks = byStage[stage] || [];
      return `
      <div class="kanban-column" data-stage="${esc(stage)}">
        <div class="column-header">
          <h3>${esc(stage)}</h3>
          <span class="column-count">${tasks.length}</span>
        </div>
        <div class="column-body">
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
    tags.push(
      `<span class="task-tag tag-artifacts">${artCount} artifact${artCount > 1 ? 's' : ''}</span>`,
    );
  }
  if (isBlocked) {
    tags.push(`<span class="task-tag tag-blocked">blocked</span>`);
  }

  return `
    <div class="task-card" onclick="openTask(${task.id})">
      <div class="task-card-id">#${task.id}</div>
      <div class="task-card-title">${esc(task.title)}</div>
      ${tags.length ? `<div class="task-card-meta">${tags.join('')}</div>` : ''}
    </div>`;
}

// ---- Modal ----

// eslint-disable-next-line no-unused-vars
function openTask(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;

  document.getElementById('modal-title').textContent = `#${task.id} — ${task.title}`;

  const deps = state.dependencies.filter((d) => d.task_id === task.id);
  const blocking = state.dependencies.filter((d) => d.depends_on === task.id);

  let html = '<div class="detail-rows">';

  const rows = [
    ['Status', task.status],
    ['Stage', task.stage],
    ['Priority', task.priority],
    ['Created by', task.created_by],
    ['Assigned to', task.assigned_to || '—'],
    ['Project', task.project || '—'],
    ['Created', formatDate(task.created_at)],
    ['Updated', formatDate(task.updated_at)],
  ];

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

  // Fetch artifacts
  fetch(`/api/tasks/${task.id}/artifacts`)
    .then((r) => r.json())
    .then((artifacts) => {
      if (artifacts.length) {
        html +=
          '<div class="artifact-list"><h3 style="margin-bottom:8px;font-size:13px;">Artifacts</h3>';
        for (const a of artifacts) {
          html += `<div class="artifact-item">
            <h4>${esc(a.name)} <span style="color:var(--text-dim);font-weight:400">(${esc(a.stage)})</span></h4>
            <pre>${esc(a.content)}</pre>
          </div>`;
        }
        html += '</div>';
      }
      document.getElementById('modal-body').innerHTML = html;
    })
    .catch(() => {
      document.getElementById('modal-body').innerHTML = html;
    });

  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('task-modal').hidden = false;
}

// eslint-disable-next-line no-unused-vars
function closeModal() {
  document.getElementById('task-modal').hidden = true;
}

document.getElementById('task-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ---- Toast ----

function showToast(title, body) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="toast-title">${esc(title)}</div><div class="toast-body">${esc(body)}</div>`;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
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
  if (!iso) return '—';
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

// ---- Boot ----

connect();
