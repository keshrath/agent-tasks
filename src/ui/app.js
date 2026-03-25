// =============================================================================
// agent-tasks — Pipeline dashboard client
//
// Complete UI overhaul: side panel detail view, rich task cards, inline editing,
// inline task creation, drag-and-drop polish, animations, responsive design.
// =============================================================================

// ---- DOM morphing (morphdom) ----

function morph(el, newInnerHTML) {
  const wrap = document.createElement(el.tagName);
  wrap.innerHTML = newInnerHTML;
  morphdom(el, wrap, {
    childrenOnly: true,
    getNodeKey(node) {
      if (node.id) return node.id;
      if (node.dataset) {
        if (node.dataset.taskId) return 'task-' + node.dataset.taskId;
        if (node.dataset.stage && node.classList && node.classList.contains('kanban-column'))
          return 'col-' + node.dataset.stage;
      }
      return null;
    },
    onBeforeElUpdated(fromEl, toEl) {
      if (fromEl.classList && fromEl.classList.contains('task-card')) {
        toEl.classList.add('no-anim');
      }
      return true;
    },
  });
}

// ---- Constants ----

const STAGE_ICONS = {
  backlog: 'inbox',
  spec: 'description',
  plan: 'map',
  implement: 'code',
  test: 'science',
  review: 'rate_review',
  done: 'check_circle',
  cancelled: 'cancel',
};

const STAGE_EMPTY_MESSAGES = {
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

const AVATAR_COLORS = [
  '#5d8da8',
  '#6f42c1',
  '#28a745',
  '#fd7e14',
  '#dc3545',
  '#007bff',
  '#5856d6',
  '#f59e0b',
  '#e83e8c',
  '#20c997',
];

const WIP_WARNING = 5;
const WIP_DANGER = 8;

// ---- State ----

const state = {
  tasks: [],
  dependencies: [],
  artifactCounts: {},
  commentCounts: {},
  subtaskProgress: {},
  collaborators: {},
  stages: ['backlog', 'spec', 'plan', 'implement', 'test', 'review', 'done', 'cancelled'],
  collapsedColumns: new Set(),
  panelTaskId: null,
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
let dragScrollInterval = null;
let activeInlineCreate = null;
let activeDropdown = null;
let _lastStatValues = {};

// ---- Restore persisted state ----

try {
  const saved = JSON.parse(localStorage.getItem('agent-tasks-filters') || '{}');
  if (saved.search) filters.search = saved.search;
  if (saved.project) filters.project = saved.project;
  if (saved.assignee) filters.assignee = saved.assignee;
  if (saved.minPriority) filters.minPriority = saved.minPriority;
} catch {
  /* ignore */
}

try {
  const collapsed = JSON.parse(localStorage.getItem('agent-tasks-collapsed') || '[]');
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

let _lastStateFingerprint = '';

function handleFullState(data) {
  const fp = quickFingerprint(data);
  if (fp === _lastStateFingerprint) return;
  _lastStateFingerprint = fp;

  state.tasks = data.tasks || [];
  state.dependencies = data.dependencies || [];
  state.artifactCounts = data.artifactCounts || {};
  state.commentCounts = data.commentCounts || {};
  state.subtaskProgress = data.subtaskProgress || {};
  state.collaborators = data.collaborators || {};
  if (data.stages) state.stages = data.stages;
  if (data.version) {
    document.getElementById('version').textContent = 'v' + data.version;
  }
  updateFilterDropdowns();
  applyRestoredFilters();
  render();
  dismissLoading();
}

function quickFingerprint(data) {
  const tasks = data.tasks || [];
  let fp = tasks.length + ':';
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
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
      if (d.task) {
        const idx = state.tasks.findIndex((t) => t.id === d.task.id);
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
        const idx = state.tasks.findIndex((t) => t.id === d.task.id);
        if (idx >= 0) state.tasks[idx] = d.task;
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
    case 'collaborator:added': {
      if (d.task_id && d.agent_id) {
        if (!state.collaborators[d.task_id]) state.collaborators[d.task_id] = [];
        const existing = state.collaborators[d.task_id].find((c) => c.agent_id === d.agent_id);
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
    const updated = d.task && d.task.id === state.panelTaskId;
    if (updated || event.type === 'artifact:created' || event.type === 'comment:created') {
      openPanel(state.panelTaskId);
    }
  }
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

// ---- Relative time ----

function relativeTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso + 'Z');
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 0) return 'just now';
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  } catch {
    return '';
  }
}

// ---- Avatar ----

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function avatarInitials(name) {
  if (!name) return '?';
  const parts = name
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .split(/[\s-]+/)
    .filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

function renderAvatar(name, sizeClass) {
  if (!name) return '';
  const color = avatarColor(name);
  const initials = avatarInitials(name);
  const cls = sizeClass ? `avatar-circle ${sizeClass}` : 'avatar-circle';
  return `<div class="${cls}" style="background:${color}" title="${esc(name)}">${esc(initials)}</div>`;
}

// ---- Markdown Rendering ----

function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    try {
      const html = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }));
      return '<div class="rendered-md prose">' + html + '</div>';
    } catch (e) {
      return '<div class="rendered-md">' + esc(text) + '</div>';
    }
  }
  return '<div class="rendered-md">' + esc(text).replace(/\n/g, '<br>') + '</div>';
}

// ---- Syntax Highlighting (via highlight.js CDN) ----

function highlightCode(code, langHint) {
  if (!code) return esc(code);
  if (typeof hljs !== 'undefined') {
    try {
      if (langHint) {
        const result = hljs.highlight(code, { language: langHint, ignoreIllegals: true });
        return result.value;
      }
      const result = hljs.highlightAuto(code);
      return result.value;
    } catch (e) {
      return esc(code);
    }
  }
  return esc(code);
}

// Keep backward compat for callers using old name
function highlightSyntax(code, langHint) {
  return highlightCode(code, langHint);
}

function detectLanguage(name) {
  if (!name) return '';
  const n = name.toLowerCase();
  if (/\.(js|ts|jsx|tsx)/.test(n) || /javascript|typescript/.test(n)) return 'javascript';
  if (/\.(py)/.test(n) || /python/.test(n)) return 'python';
  if (/\.(sh|bash)/.test(n) || /shell|bash/.test(n)) return 'bash';
  if (/\.json/.test(n)) return 'json';
  if (/\.(css|scss)/.test(n)) return 'css';
  if (/\.(html|xml)/.test(n)) return 'xml';
  if (/\.sql/.test(n)) return 'sql';
  if (/\.ya?ml/.test(n)) return 'yaml';
  if (/\.rs/.test(n) || /rust/.test(n)) return 'rust';
  if (/\.go/.test(n)) return 'go';
  return '';
}

// ---- Diff Detection & Rendering ----

function isDiff(content) {
  if (!content) return false;
  const dLines = content.split('\n').slice(0, 30);
  let hasHunkHeader = false;
  let hasMinusFile = false;
  let hasPlusFile = false;
  let hasDiffCmd = false;
  for (const line of dLines) {
    if (/^@@\s/.test(line)) hasHunkHeader = true;
    if (/^--- [ab\/]/.test(line)) hasMinusFile = true;
    if (/^\+\+\+ [ab\/]/.test(line)) hasPlusFile = true;
    if (/^diff --git/.test(line)) hasDiffCmd = true;
  }
  return hasHunkHeader || (hasMinusFile && hasPlusFile) || hasDiffCmd;
}

function renderDiff(content) {
  const dLines = content.split('\n');
  const leftRows = [];
  const rightRows = [];
  let leftLn = 0;
  let rightLn = 0;

  for (const line of dLines) {
    if (/^(---|\+\+\+|diff |index )/.test(line)) {
      continue;
    } else if (/^@@/.test(line)) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) {
        leftLn = parseInt(m[1], 10) - 1;
        rightLn = parseInt(m[2], 10) - 1;
      }
      const escaped = esc(line);
      leftRows.push('<tr class="diff-section-header"><td colspan="2">' + escaped + '</td></tr>');
      rightRows.push('<tr class="diff-section-header"><td colspan="2">' + escaped + '</td></tr>');
    } else if (/^\+/.test(line)) {
      rightLn++;
      const escaped = esc(line.slice(1));
      leftRows.push(
        '<tr class="diff-add"><td class="diff-ln"></td><td class="diff-code"></td></tr>',
      );
      rightRows.push(
        '<tr class="diff-add"><td class="diff-ln">' +
          rightLn +
          '</td><td class="diff-code">' +
          escaped +
          '</td></tr>',
      );
    } else if (/^-/.test(line)) {
      leftLn++;
      const escaped = esc(line.slice(1));
      leftRows.push(
        '<tr class="diff-del"><td class="diff-ln">' +
          leftLn +
          '</td><td class="diff-code">' +
          escaped +
          '</td></tr>',
      );
      rightRows.push(
        '<tr class="diff-del"><td class="diff-ln"></td><td class="diff-code"></td></tr>',
      );
    } else {
      leftLn++;
      rightLn++;
      const text = line.startsWith(' ') ? line.slice(1) : line;
      const escaped = esc(text);
      leftRows.push(
        '<tr class="diff-context"><td class="diff-ln">' +
          leftLn +
          '</td><td class="diff-code">' +
          escaped +
          '</td></tr>',
      );
      rightRows.push(
        '<tr class="diff-context"><td class="diff-ln">' +
          rightLn +
          '</td><td class="diff-code">' +
          escaped +
          '</td></tr>',
      );
    }
  }

  return (
    '<div class="diff-viewer">' +
    '<div class="diff-side diff-left"><div class="diff-header">Original</div>' +
    '<table class="diff-table">' +
    leftRows.join('') +
    '</table></div>' +
    '<div class="diff-side diff-right"><div class="diff-header">Modified</div>' +
    '<table class="diff-table">' +
    rightRows.join('') +
    '</table></div>' +
    '</div>'
  );
}

// ---- Expandable Artifact Rendering ----

function renderArtifactContent(content, name) {
  if (isDiff(content)) return renderDiff(content);
  const lang = detectLanguage(name, content);
  const highlighted = highlightSyntax(content, lang);
  const aLines = content.split('\n');
  const lineNums = aLines.map((_, i) => i + 1).join('\n');
  return (
    '<div class="artifact-lines"><div class="artifact-line-numbers">' +
    lineNums +
    '</div><div class="artifact-line-content"><pre class="artifact-code">' +
    highlighted +
    '</pre></div></div>'
  );
}

function renderArtifactBlock(artifact) {
  const vLabel = artifact.version > 1 ? ' v' + artifact.version : '';
  const aLines = (artifact.content || '').split('\n');
  const needsCollapse = aLines.length > 8;
  const wrapperClass = needsCollapse
    ? 'artifact-wrapper artifact-collapsed'
    : 'artifact-wrapper artifact-expanded';
  const artId = 'artifact-' + artifact.id;
  let html = '<div class="panel-artifact"><div class="artifact-header">';
  html +=
    '<h4><span class="material-symbols-outlined" style="font-size:14px">description</span> ' +
    esc(artifact.name) +
    vLabel +
    ' <span style="color:var(--text-dim);font-weight:400">(' +
    esc(artifact.stage) +
    ', ' +
    esc(artifact.created_by) +
    ')</span></h4>';
  html +=
    '<button class="artifact-fullscreen-btn" data-artifact-id="' +
    artId +
    '" title="Open fullscreen"><span class="material-symbols-outlined">open_in_full</span></button>' +
    '<button class="artifact-copy-btn" data-artifact-id="' +
    artId +
    '" title="Copy to clipboard"><span class="material-symbols-outlined">content_copy</span> Copy</button>';
  html += '</div><div class="' + wrapperClass + '" id="' + artId + '">';
  html += renderArtifactContent(artifact.content || '', artifact.name || '');
  html += '<div class="artifact-fade"></div></div>';
  if (needsCollapse) {
    html +=
      '<button class="artifact-toggle" data-artifact-id="' +
      artId +
      '"><span class="material-symbols-outlined">expand_more</span> Show more (' +
      aLines.length +
      ' lines)</button>';
  }
  html += '</div>';
  return html;
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

  const statsEl = document.getElementById('stats');
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

function renderBoard() {
  const board = document.getElementById('board');
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

        let bodyContent;
        if (tasks.length === 0 && !isCollapsed) {
          bodyContent = `<div class="column-empty">
        <span class="material-symbols-outlined">${emptyMsg.icon}</span>
        <div class="empty-text">${esc(emptyMsg.text)}</div>
        ${emptyMsg.cta ? `<div class="empty-cta" data-action="add-task" data-stage="${esc(stage)}">${emptyMsg.ctaIcon ? `<span class="material-symbols-outlined">${emptyMsg.ctaIcon}</span>` : ''}${esc(emptyMsg.cta)}</div>` : ''}
      </div>`;
        } else {
          bodyContent = tasks.map((t, i) => renderCard(t, blocked.has(t.id), stage, i)).join('');
        }

        return `<div class="${colClass}" id="col-${esc(stage)}" data-stage="${esc(stage)}">
      <div class="column-header" data-action="toggle-collapse" data-stage="${esc(stage)}">
        <div class="column-header-left">
          <span class="material-symbols-outlined">${icon}</span>
          <h3>${esc(stage)}</h3>
        </div>
        <span class="${countClass}" aria-label="${tasks.length} tasks">${tasks.length}</span>
      </div>
      <div class="column-body" role="listbox" aria-label="${esc(stage)} tasks">
        ${bodyContent}
      </div>
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

function renderCard(task, isBlocked, stage, index) {
  const tags = [];

  if (task.project) {
    tags.push(`<span class="task-tag tag-project">${esc(task.project)}</span>`);
  }
  if (task.priority > 0) {
    tags.push(
      `<span class="task-tag tag-priority clickable" data-action="cycle-priority" data-task-id="${task.id}" title="Click to cycle priority">P${task.priority}</span>`,
    );
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

function renderCollaborators(collabs) {
  if (!collabs || collabs.length === 0) return '';
  const maxVisible = 3;
  const visible = collabs.slice(0, maxVisible);
  const overflow = collabs.length - maxVisible;
  let html = '<div class="task-card-collabs">';
  for (const c of visible) {
    const initials = avatarInitials(c.agent_id);
    const color = avatarColor(c.agent_id);
    html += `<div class="collab-avatar" style="background:${color}" title="${esc(c.agent_id)} (${esc(c.role)})">${esc(initials)}</div>`;
  }
  if (overflow > 0) {
    html += `<div class="collab-overflow" title="${collabs.length} collaborators">+${overflow}</div>`;
  }
  html += '</div>';
  return html;
}

// ---- Event Delegation (board) ----

document.getElementById('board').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]');

  if (action) {
    const act = action.dataset.action;

    if (act === 'toggle-collapse') {
      e.stopPropagation();
      const stage = action.dataset.stage;
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
      showInlineCreate(action.dataset.stage);
      return;
    }

    if (act === 'add-task') {
      e.stopPropagation();
      showInlineCreate(action.dataset.stage);
      return;
    }

    if (act === 'cycle-priority') {
      e.stopPropagation();
      cyclePriority(parseInt(action.dataset.taskId, 10));
      return;
    }

    if (act === 'change-assignee') {
      e.stopPropagation();
      showAssigneeDropdown(parseInt(action.dataset.taskId, 10), action);
      return;
    }
  }

  const card = e.target.closest('.task-card[data-task-id]');
  if (card) {
    openPanel(parseInt(card.dataset.taskId, 10));
  }
});

document.getElementById('board').addEventListener('dblclick', (e) => {
  const titleEl = e.target.closest('[data-action="edit-title"]');
  if (titleEl) {
    e.stopPropagation();
    startInlineEdit(titleEl);
  }
});

document.getElementById('board').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const card = e.target.closest('.task-card[data-task-id]');
    if (card) openPanel(parseInt(card.dataset.taskId, 10));
  }
});

// ---- Collapsed column click (expand) ----

document.getElementById('board').addEventListener('click', (e) => {
  const col = e.target.closest('.kanban-column.collapsed');
  if (col) {
    const stage = col.dataset.stage;
    state.collapsedColumns.delete(stage);
    saveCollapsed();
    render();
  }
});

// ---- Drag and Drop ----

document.getElementById('board').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.task-card[data-task-id]');
  if (card) onDragStart(e, card);
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
  if (col && !col.contains(e.relatedTarget)) {
    col.classList.remove('drag-over');
  }
});

document.getElementById('board').addEventListener('drop', (e) => {
  const col = e.target.closest('.kanban-column');
  if (col) onDrop(e, col);
});

function onDragStart(e, card) {
  draggedTaskId = parseInt(card.dataset.taskId, 10);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(draggedTaskId));

  requestAnimationFrame(() => {
    card.classList.add('dragging');
  });

  startDragAutoScroll();
}

function onDragEnd(e) {
  const card = e.target.closest('.task-card');
  if (card) card.classList.remove('dragging');
  draggedTaskId = null;
  stopDragAutoScroll();
  document
    .querySelectorAll('.kanban-column.drag-over')
    .forEach((c) => c.classList.remove('drag-over'));
  document.querySelectorAll('.drop-placeholder').forEach((p) => p.remove());
  const board = document.getElementById('board');
  board.classList.remove('drag-scroll-left', 'drag-scroll-right');
}

function onDragOver(e, col) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (col && !col.classList.contains('drag-over')) {
    document
      .querySelectorAll('.kanban-column.drag-over')
      .forEach((c) => c.classList.remove('drag-over'));
    col.classList.add('drag-over');
  }
}

function onDrop(e, col) {
  e.preventDefault();
  if (col) col.classList.remove('drag-over');
  document.querySelectorAll('.drop-placeholder').forEach((p) => p.remove());

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

function startDragAutoScroll() {
  const board = document.getElementById('board');
  dragScrollInterval = setInterval(() => {
    if (!draggedTaskId) return;
    const rect = board.getBoundingClientRect();
    const mouseX = _lastMouseX;
    const edgeSize = 80;

    if (mouseX < rect.left + edgeSize) {
      board.scrollLeft -= 8;
      board.classList.add('drag-scroll-left');
    } else {
      board.classList.remove('drag-scroll-left');
    }

    if (mouseX > rect.right - edgeSize) {
      board.scrollLeft += 8;
      board.classList.add('drag-scroll-right');
    } else {
      board.classList.remove('drag-scroll-right');
    }
  }, 16);
}

function stopDragAutoScroll() {
  clearInterval(dragScrollInterval);
  dragScrollInterval = null;
}

let _lastMouseX = 0;
document.addEventListener('dragover', (e) => {
  _lastMouseX = e.clientX;
});

// ---- Side Panel ----

function openPanel(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;

  state.panelTaskId = id;
  const wrapper = document.getElementById('board-wrapper');
  wrapper.classList.add('panel-open');

  const panel = document.getElementById('side-panel');
  const hasArtifacts = (state.artifactCounts[id] || 0) > 0;
  if (hasArtifacts) {
    panel.classList.add('panel-wide');
  } else {
    panel.classList.remove('panel-wide');
  }

  renderPanelContent(task);
  highlightActiveCard(id);

  showPanelBackdrop();
}

function closePanel() {
  state.panelTaskId = null;
  const wrapper = document.getElementById('board-wrapper');
  wrapper.classList.remove('panel-open');
  hidePanelBackdrop();
  highlightActiveCard(null);
}

function showPanelBackdrop() {
  let backdrop = document.getElementById('panel-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'panel-backdrop';
    backdrop.className = 'panel-backdrop';
    backdrop.addEventListener('click', closePanel);
    document.body.appendChild(backdrop);
  }
  backdrop.style.display = '';
}

function hidePanelBackdrop() {
  const backdrop = document.getElementById('panel-backdrop');
  if (backdrop) backdrop.style.display = 'none';
}

function highlightActiveCard(id) {
  document
    .querySelectorAll('.task-card.active-card')
    .forEach((c) => c.classList.remove('active-card'));
  if (id) {
    const card = document.querySelector(`.task-card[data-task-id="${id}"]`);
    if (card) card.classList.add('active-card');
  }
}

function renderPanelContent(task) {
  const panel = document.getElementById('side-panel');
  const panelBody = document.getElementById('panel-body');
  const panelHeader = document.getElementById('panel-header-content');

  const stageClass = `stage-${task.stage}`;

  panelHeader.innerHTML = `
    <div class="panel-header-left">
      <span class="panel-task-id">#${task.id}</span>
      <span class="panel-stage-badge ${stageClass}">${esc(task.stage)}</span>
    </div>
    <button class="panel-close-btn" data-action="close-panel" aria-label="Close panel">
      <span class="material-symbols-outlined">close</span>
    </button>`;

  const deps = state.dependencies.filter((d) => d.task_id === task.id);
  const blocking = state.dependencies.filter((d) => d.depends_on === task.id);

  let html = `<div class="panel-title">${esc(task.title)}</div>`;

  html += '<div class="panel-section">';
  html +=
    '<div class="panel-section-title"><span class="material-symbols-outlined">info</span> Details</div>';
  html += '<div class="panel-grid">';

  const gridRows = [
    ['Status', task.status],
    ['Priority', `P${task.priority}`],
    ['Created by', task.created_by || '\u2014'],
    ['Assigned to', task.assigned_to || '\u2014'],
    ['Project', task.project || '\u2014'],
    ['Created', formatDate(task.created_at)],
    ['Updated', relativeTime(task.updated_at) || formatDate(task.updated_at)],
  ];

  if (task.parent_id) {
    const parent = state.tasks.find((t) => t.id === task.parent_id);
    gridRows.push(['Parent', parent ? `#${parent.id} ${parent.title}` : `#${task.parent_id}`]);
  }

  if (task.tags) {
    try {
      const parsed = JSON.parse(task.tags);
      if (Array.isArray(parsed) && parsed.length) {
        gridRows.push(['Tags', parsed.join(', ')]);
      }
    } catch {
      /* ignore */
    }
  }

  for (const [label, value] of gridRows) {
    html += `<span class="panel-label">${esc(label)}</span><span class="panel-value">${esc(String(value))}</span>`;
  }

  html += '</div></div>';

  if (task.description) {
    html += '<div class="panel-section">';
    html +=
      '<div class="panel-section-title"><span class="material-symbols-outlined">notes</span> Description</div>';
    html += `<div class="panel-description">${renderMarkdown(task.description)}</div>`;
    html += '</div>';
  }

  if (task.result) {
    html += '<div class="panel-section">';
    html +=
      '<div class="panel-section-title"><span class="material-symbols-outlined">output</span> Result</div>';
    html += `<div class="panel-description">${renderMarkdown(task.result)}</div>`;
    html += '</div>';
  }

  if (deps.length) {
    html += '<div class="panel-section">';
    html +=
      '<div class="panel-section-title"><span class="material-symbols-outlined">link</span> Dependencies</div>';
    for (const d of deps) {
      const t = state.tasks.find((x) => x.id === d.depends_on);
      const name = t ? `${t.title}` : `Task`;
      html += `<div class="panel-subtask" data-subtask-id="${d.depends_on}">
        <span class="subtask-id">#${d.depends_on}</span>
        <span>${esc(name)}</span>
        ${t ? `<span class="subtask-stage stage-${t.stage}">${esc(t.stage)}</span>` : ''}
      </div>`;
    }
    html += '</div>';
  }

  if (blocking.length) {
    html += '<div class="panel-section">';
    html +=
      '<div class="panel-section-title"><span class="material-symbols-outlined">block</span> Blocks</div>';
    for (const d of blocking) {
      const t = state.tasks.find((x) => x.id === d.task_id);
      const name = t ? `${t.title}` : `Task`;
      html += `<div class="panel-subtask" data-subtask-id="${d.task_id}">
        <span class="subtask-id">#${d.task_id}</span>
        <span>${esc(name)}</span>
        ${t ? `<span class="subtask-stage stage-${t.stage}">${esc(t.stage)}</span>` : ''}
      </div>`;
    }
    html += '</div>';
  }

  const skeletonHTML =
    '<div class="panel-loading">' +
    '<div class="skeleton-line skeleton-wide"></div>' +
    '<div class="skeleton-line"></div>' +
    '<div class="skeleton-line"></div>' +
    '<div class="skeleton-line skeleton-short"></div>' +
    '</div>';

  panelBody.innerHTML = html + skeletonHTML;

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
      extra += '<div class="panel-section">';
      extra += `<div class="panel-section-title"><span class="material-symbols-outlined">account_tree</span> Subtasks (${subtasks.length})</div>`;
      for (const s of subtasks) {
        extra += `<div class="panel-subtask" data-subtask-id="${s.id}">
          <span class="subtask-id">#${s.id}</span>
          <span>${esc(s.title)}</span>
          <span class="subtask-stage stage-${s.stage}">${esc(s.stage)}</span>
        </div>`;
      }
      extra += '</div>';
    }

    if (artifacts.length) {
      extra += '<div class="panel-section">';
      extra += `<div class="panel-section-title"><span class="material-symbols-outlined">inventory_2</span> Artifacts (${artifacts.length})</div>`;
      for (const a of artifacts) {
        extra += renderArtifactBlock(a);
      }
      extra += '</div>';
    }

    extra += '<div class="panel-section panel-comments">';
    extra += `<div class="panel-section-title"><span class="material-symbols-outlined">chat</span> Comments (${comments.length})</div>`;
    for (const c of comments) {
      const isReply = c.parent_comment_id ? ' reply' : '';
      extra += `<div class="comment-item${isReply}">
        <div class="comment-header">
          ${renderAvatar(c.agent_id, 'avatar-sm')}
          <span class="comment-agent">${esc(c.agent_id)}</span>
          <span class="comment-time">${relativeTime(c.created_at) || formatDate(c.created_at)}</span>
        </div>
        <div class="comment-body">${renderMarkdown(c.content)}</div>
      </div>`;
    }
    extra += `<div class="comment-form">
      <textarea id="comment-input" placeholder="Add a comment..." rows="1" aria-label="Add a comment"></textarea>
      <button id="comment-send-btn" data-task-id="${task.id}" aria-label="Send comment">Send</button>
    </div></div>`;

    panelBody.innerHTML = html + extra;
  });
}

// ---- Panel event delegation ----

document.getElementById('side-panel').addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-action="close-panel"]');
  if (closeBtn) {
    closePanel();
    return;
  }

  const subtask = e.target.closest('[data-subtask-id]');
  if (subtask) {
    openPanel(parseInt(subtask.dataset.subtaskId, 10));
    return;
  }

  const sendBtn = e.target.closest('#comment-send-btn');
  if (sendBtn) {
    submitComment(parseInt(sendBtn.dataset.taskId, 10));
    return;
  }

  const toggleBtn = e.target.closest('.artifact-toggle');
  if (toggleBtn) {
    const artId = toggleBtn.dataset.artifactId;
    if (artId) toggleArtifact(artId);
    return;
  }

  const copyBtn = e.target.closest('.artifact-copy-btn');
  if (copyBtn) {
    copyArtifact(copyBtn);
    return;
  }

  const fsBtn = e.target.closest('.artifact-fullscreen-btn');
  if (fsBtn) {
    const artId = fsBtn.dataset.artifactId;
    if (artId) openArtifactFullscreen(artId);
    return;
  }
});

// ---- Artifact fullscreen ----

function openArtifactFullscreen(artId) {
  const wrapper = document.getElementById(artId);
  if (!wrapper) return;
  const content = wrapper.querySelector('.artifact-code, .diff-viewer');
  if (!content) return;

  const header = wrapper.closest('.panel-artifact')?.querySelector('h4');
  const title = header ? header.textContent : 'Artifact';

  const overlay = document.createElement('div');
  overlay.className = 'artifact-fullscreen-overlay';
  overlay.innerHTML =
    '<div class="artifact-fullscreen-header">' +
    '<h3>' +
    esc(title) +
    '</h3>' +
    '<button class="icon-btn" aria-label="Close fullscreen"><span class="material-symbols-outlined">close</span></button>' +
    '</div>' +
    '<div class="artifact-fullscreen-body"></div>';

  const body = overlay.querySelector('.artifact-fullscreen-body');
  body.innerHTML = wrapper.innerHTML;
  const fade = body.querySelector('.artifact-fade');
  if (fade) fade.remove();
  // Expand everything in fullscreen
  const artWrapper = body.querySelector('.artifact-wrapper');
  if (artWrapper) {
    artWrapper.classList.remove('artifact-collapsed');
    artWrapper.classList.add('artifact-expanded');
  }

  overlay.querySelector('button').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.remove();
  });

  document.body.appendChild(overlay);
  overlay.querySelector('button').focus();
}

// ---- Panel resize ----

(function initPanelResize() {
  const panel = document.getElementById('side-panel');
  if (!panel) return;
  const handle = document.createElement('div');
  handle.className = 'panel-resize-handle';
  panel.appendChild(handle);

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const dx = startX - e.clientX;
    const newWidth = Math.max(400, Math.min(startWidth + dx, window.innerWidth * 0.8));
    panel.style.width = newWidth + 'px';
    panel.style.minWidth = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ---- Inline Task Creation ----

function showInlineCreate(stage) {
  dismissInlineCreate();

  const col = document.querySelector(`.kanban-column[data-stage="${stage}"]`);
  if (!col) return;

  const addBtn = col.querySelector('.column-add-btn');
  if (addBtn) addBtn.style.display = 'none';

  const form = document.createElement('div');
  form.className = 'inline-create-form';
  form.innerHTML = `<div class="inline-create-card">
    <input class="inline-create-input" type="text" placeholder="Task title..." autofocus />
    <div class="inline-create-hint">
      <span><kbd>Enter</kbd> to create</span>
      <span><kbd>Esc</kbd> to cancel</span>
    </div>
  </div>`;

  col.appendChild(form);
  activeInlineCreate = { stage, form, col };

  const input = form.querySelector('.inline-create-input');
  input.focus();

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      e.preventDefault();
      createTaskInline(input.value.trim(), stage);
      dismissInlineCreate();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      dismissInlineCreate();
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(() => dismissInlineCreate(), 150);
  });
}

function dismissInlineCreate() {
  if (!activeInlineCreate) return;
  const { form, col } = activeInlineCreate;
  if (form && form.parentNode) form.remove();
  const addBtn = col.querySelector('.column-add-btn');
  if (addBtn) addBtn.style.display = '';
  activeInlineCreate = null;
}

function createTaskInline(title, stage) {
  fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, stage, created_by: 'dashboard' }),
  })
    .then((r) => r.json())
    .then((result) => {
      if (result.error) {
        showToast('Create failed', result.error, 'error');
      }
    })
    .catch(() => showToast('Create failed', 'Network error', 'error'));
}

// ---- Inline Editing ----

function startInlineEdit(titleEl) {
  const taskId = parseInt(titleEl.dataset.taskId, 10);
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

  titleEl.setAttribute('contenteditable', 'true');
  titleEl.focus();

  const range = document.createRange();
  range.selectNodeContents(titleEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = () => {
    titleEl.removeAttribute('contenteditable');
    const newTitle = titleEl.textContent.trim();
    if (newTitle && newTitle !== task.title) {
      updateTask(taskId, { title: newTitle });
    } else {
      titleEl.textContent = task.title;
    }
  };

  titleEl.addEventListener('blur', finish, { once: true });
  titleEl.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        titleEl.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        titleEl.textContent = task.title;
        titleEl.removeAttribute('contenteditable');
      }
    },
    { once: true },
  );
}

function cyclePriority(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

  const levels = [0, 1, 3, 5, 10];
  const current = levels.indexOf(task.priority);
  const next = levels[(current + 1) % levels.length];
  updateTask(taskId, { priority: next });
}

function showAssigneeDropdown(taskId, anchor) {
  dismissDropdown();

  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

  const assignees = [...new Set(state.tasks.map((t) => t.assigned_to).filter(Boolean))].sort();
  if (!assignees.length) return;

  const dropdown = document.createElement('div');
  dropdown.className = 'inline-dropdown';

  dropdown.innerHTML =
    `<div class="inline-dropdown-item${!task.assigned_to ? ' active' : ''}" data-value="">
    <span style="color:var(--text-dim)">Unassigned</span>
  </div>` +
    assignees
      .map(
        (a) =>
          `<div class="inline-dropdown-item${task.assigned_to === a ? ' active' : ''}" data-value="${esc(a)}">
      ${renderAvatar(a, 'avatar-sm')}
      <span>${esc(a)}</span>
    </div>`,
      )
      .join('');

  const rect = anchor.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  dropdown.style.top = `${rect.bottom + 4}px`;
  dropdown.style.left = `${Math.max(8, rect.left - 100)}px`;

  document.body.appendChild(dropdown);
  activeDropdown = dropdown;

  dropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.inline-dropdown-item');
    if (item) {
      const value = item.dataset.value || null;
      updateTask(taskId, { assigned_to: value });
      dismissDropdown();
    }
  });

  setTimeout(() => {
    document.addEventListener('click', dismissDropdownOnOutsideClick, { once: true });
  }, 0);
}

function dismissDropdown() {
  if (activeDropdown) {
    activeDropdown.remove();
    activeDropdown = null;
  }
}

function dismissDropdownOnOutsideClick(e) {
  if (activeDropdown && !activeDropdown.contains(e.target)) {
    dismissDropdown();
  }
}

function updateTask(taskId, updates) {
  fetch(`/api/tasks/${taskId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
    .then((r) => r.json())
    .then((result) => {
      if (result.error) {
        showToast('Update failed', result.error, 'error');
      }
    })
    .catch(() => showToast('Update failed', 'Network error', 'error'));
}

// ---- Comment submission ----

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
      openPanel(taskId);
    })
    .catch(() => showToast('Error', 'Failed to post comment', 'error'));
}

// ---- Legacy Modal (cleanup only) ----

function closeModal() {
  document.getElementById('task-modal').hidden = true;
}

document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
document.getElementById('task-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

// ---- Keyboard Navigation ----

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (activeDropdown) {
      dismissDropdown();
      return;
    }
    if (activeInlineCreate) {
      dismissInlineCreate();
      return;
    }
    if (state.panelTaskId) {
      closePanel();
      return;
    }
    const modal = document.getElementById('task-modal');
    if (!modal.hidden) {
      closeModal();
      return;
    }
    const cleanupModal = document.getElementById('cleanup-modal');
    if (!cleanupModal.classList.contains('hidden')) {
      cleanupModal.classList.add('hidden');
      return;
    }
  }

  const isInput =
    document.activeElement?.tagName === 'INPUT' ||
    document.activeElement?.tagName === 'TEXTAREA' ||
    document.activeElement?.getAttribute('contenteditable') === 'true';

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

document.getElementById('cleanup-everything')?.addEventListener('click', () => {
  if (
    !confirm(
      'This will remove ALL tasks — completed, in-progress, everything. This cannot be undone. Continue?',
    )
  )
    return;
  document.getElementById('cleanup-modal').classList.add('hidden');
  fetch('/api/cleanup', {
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

// ---- Artifact interactions ----

function toggleArtifact(id) {
  const wrapper = document.getElementById(id);
  if (!wrapper) return;
  const isCollapsed = wrapper.classList.contains('artifact-collapsed');
  wrapper.classList.toggle('artifact-collapsed', !isCollapsed);
  wrapper.classList.toggle('artifact-expanded', isCollapsed);
  const btn = wrapper.parentElement.querySelector('.artifact-toggle');
  if (btn) {
    const icon = btn.querySelector('.material-symbols-outlined');
    if (isCollapsed) {
      icon.textContent = 'expand_less';
      btn.childNodes[btn.childNodes.length - 1].textContent = ' Show less';
    } else {
      icon.textContent = 'expand_more';
      const codeEl = wrapper.querySelector('.artifact-code, .diff-viewer');
      const count = codeEl ? codeEl.textContent.split('\n').length : 0;
      btn.childNodes[btn.childNodes.length - 1].textContent = ' Show more (' + count + ' lines)';
    }
  }
}

function copyArtifact(btn) {
  const artifactEl = btn.closest('.panel-artifact');
  if (!artifactEl) return;
  const codeEl = artifactEl.querySelector('.artifact-code, .diff-viewer');
  if (!codeEl) return;
  const text = codeEl.textContent || '';
  navigator.clipboard
    .writeText(text)
    .then(function () {
      const origHtml = btn.innerHTML;
      btn.innerHTML = '<span class="material-symbols-outlined">check</span> Copied';
      setTimeout(function () {
        btn.innerHTML = origHtml;
      }, 1500);
    })
    .catch(function () {
      /* fallback */
    });
}

// ---- Boot ----

connect();
