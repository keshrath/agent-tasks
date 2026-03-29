// =============================================================================
// agent-tasks — Panel Module
//
// Side panel detail view, artifact/decision/learning rendering, comments,
// artifact fullscreen, panel resize.
// =============================================================================

window.TaskBoard = window.TaskBoard || {};

// ---- Expandable Artifact Rendering ----

function renderArtifactContent(content, name) {
  var isDiff = TaskBoard.isDiff;
  var renderDiff = TaskBoard.renderDiff;
  var detectLanguage = TaskBoard.detectLanguage;
  var highlightSyntax = TaskBoard.highlightSyntax;

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
  var esc = TaskBoard.esc;
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

// ---- Decision rendering ----

function renderDecisionBlock(artifact) {
  var esc = TaskBoard.esc;
  const content = artifact.content || '';
  const choseMatch = content.match(/\*\*Chose:\*\*\s*(.+)/);
  const overMatch = content.match(/\*\*Over:\*\*\s*(.+)/);
  const becauseMatch = content.match(/\*\*Because:\*\*\s*(.+)/);
  const chose = choseMatch ? choseMatch[1].trim() : '';
  const over = overMatch ? overMatch[1].trim() : '';
  const because = becauseMatch ? becauseMatch[1].trim() : '';
  if (!chose) return renderArtifactBlock(artifact);
  const vLabel = artifact.version > 1 ? ' v' + artifact.version : '';
  return `<div class="panel-decision"><div class="decision-header"><span class="material-symbols-outlined">gavel</span> Decision${vLabel} <span style="color:var(--text-dim);font-weight:400">(${esc(artifact.stage)}, ${esc(artifact.created_by)})</span></div><div class="decision-body"><div class="decision-row"><span class="decision-label">Chose</span><span class="decision-value decision-chose">${esc(chose)}</span></div><div class="decision-row"><span class="decision-label">Over</span><span class="decision-value decision-over">${esc(over)}</span></div><div class="decision-row"><span class="decision-label">Because</span><span class="decision-value decision-because">${esc(because)}</span></div></div></div>`;
}

// ---- Learning rendering ----

function renderLearningBlock(artifact) {
  var esc = TaskBoard.esc;
  var renderMarkdown = TaskBoard.renderMarkdown;
  const content = artifact.content || '';
  const categoryMatch = content.match(/^\[(technique|pitfall|decision|pattern)\]\s*/);
  const category = categoryMatch ? categoryMatch[1] : 'technique';
  const body = categoryMatch ? content.slice(categoryMatch[0].length) : content;
  const sourceMatch = body.match(/^Learning from (subtask|sibling) #(\d+):\s*/);
  const sourceLabel = sourceMatch ? `from ${sourceMatch[1]} #${sourceMatch[2]}` : '';
  const displayBody = sourceMatch ? body.slice(sourceMatch[0].length) : body;
  const categoryIcons = {
    technique: 'construction',
    pitfall: 'warning',
    decision: 'gavel',
    pattern: 'pattern',
  };
  const categoryIcon = categoryIcons[category] || 'lightbulb';
  const vLabel = artifact.version > 1 ? ' v' + artifact.version : '';
  return `<div class="panel-learning"><div class="learning-header"><span class="material-symbols-outlined learning-icon">${categoryIcon}</span><span class="learning-category">${esc(category)}</span>${vLabel}${sourceLabel ? `<span class="learning-source">${esc(sourceLabel)}</span>` : ''}<span style="color:var(--text-dim);font-weight:400;margin-left:auto;font-size:11px">${esc(artifact.created_by)}</span></div><div class="learning-body">${renderMarkdown(displayBody)}</div></div>`;
}

// ---- Panel open/close ----

function openPanel(id) {
  var state = TaskBoard.state;
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
  TaskBoard.state.panelTaskId = null;
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

// ---- Panel content rendering ----

function renderPanelContent(task) {
  var state = TaskBoard.state;
  var esc = TaskBoard.esc;
  var formatDate = TaskBoard.formatDate;
  var relativeTime = TaskBoard.relativeTime;
  var renderMarkdown = TaskBoard.renderMarkdown;
  var renderAvatar = TaskBoard.renderAvatar;

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

    const decisions = artifacts.filter((a) => a.name === 'decision');
    const learnings = artifacts.filter((a) => a.name === 'learning');
    const otherArtifacts = artifacts.filter((a) => a.name !== 'decision' && a.name !== 'learning');

    if (learnings.length) {
      extra += '<div class="panel-section">';
      extra += `<div class="panel-section-title"><span class="material-symbols-outlined">lightbulb</span> Learnings (${learnings.length})</div>`;
      for (const l of learnings) {
        extra += renderLearningBlock(l);
      }
      extra += '</div>';
    }

    if (decisions.length) {
      extra += '<div class="panel-section">';
      extra += `<div class="panel-section-title"><span class="material-symbols-outlined">gavel</span> Decisions (${decisions.length})</div>`;
      for (const d of decisions) {
        extra += renderDecisionBlock(d);
      }
      extra += '</div>';
    }

    if (otherArtifacts.length) {
      extra += '<div class="panel-section">';
      extra += `<div class="panel-section-title"><span class="material-symbols-outlined">inventory_2</span> Artifacts (${otherArtifacts.length})</div>`;
      for (const a of otherArtifacts) {
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
    .catch(() => TaskBoard.showToast('Error', 'Failed to post comment', 'error'));
}

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

// ---- Artifact fullscreen ----

function openArtifactFullscreen(artId) {
  var esc = TaskBoard.esc;
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

function initPanelResize() {
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
}

// ---- Panel event delegation ----

function initPanelEvents() {
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
}

// ---- Register on namespace ----

TaskBoard.renderArtifactContent = renderArtifactContent;
TaskBoard.renderArtifactBlock = renderArtifactBlock;
TaskBoard.renderDecisionBlock = renderDecisionBlock;
TaskBoard.renderLearningBlock = renderLearningBlock;
TaskBoard.openPanel = openPanel;
TaskBoard.closePanel = closePanel;
TaskBoard.submitComment = submitComment;
TaskBoard.toggleArtifact = toggleArtifact;
TaskBoard.copyArtifact = copyArtifact;
TaskBoard.openArtifactFullscreen = openArtifactFullscreen;
TaskBoard.initPanelResize = initPanelResize;
TaskBoard.initPanelEvents = initPanelEvents;
