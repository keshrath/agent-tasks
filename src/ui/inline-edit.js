// =============================================================================
// agent-tasks — Inline Edit Module
//
// Inline task creation, inline title editing, priority cycling, assignee
// dropdown, task update API calls.
// =============================================================================

window.TaskBoard = window.TaskBoard || {};

var activeInlineCreate = null;
var activeDropdown = null;

// ---- Inline Task Creation ----

function showInlineCreate(stage) {
  dismissInlineCreate();

  const col = TaskBoard._root.querySelector(`.kanban-column[data-stage="${stage}"]`);
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
  var showToast = TaskBoard.showToast;
  TaskBoard._fetch('/api/tasks', {
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

// ---- Inline Title Editing ----

function startInlineEdit(titleEl) {
  var state = TaskBoard.state;
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

// ---- Priority Cycling ----

function cyclePriority(taskId) {
  var state = TaskBoard.state;
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

  const levels = [0, 1, 3, 5, 10];
  const current = levels.indexOf(task.priority);
  const next = levels[(current + 1) % levels.length];
  updateTask(taskId, { priority: next });
}

// ---- Assignee Dropdown ----

function showAssigneeDropdown(taskId, anchor) {
  dismissDropdown();

  var state = TaskBoard.state;
  var esc = TaskBoard.esc;
  var renderAvatar = TaskBoard.renderAvatar;
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

// ---- Task update API ----

function updateTask(taskId, updates) {
  var showToast = TaskBoard.showToast;
  TaskBoard._fetch(`/api/tasks/${taskId}`, {
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

// ---- Getters for keyboard handler ----

function getActiveInlineCreate() {
  return activeInlineCreate;
}

function getActiveDropdown() {
  return activeDropdown;
}

// ---- Register on namespace ----

TaskBoard.showInlineCreate = showInlineCreate;
TaskBoard.dismissInlineCreate = dismissInlineCreate;
TaskBoard.startInlineEdit = startInlineEdit;
TaskBoard.cyclePriority = cyclePriority;
TaskBoard.showAssigneeDropdown = showAssigneeDropdown;
TaskBoard.dismissDropdown = dismissDropdown;
TaskBoard.updateTask = updateTask;
TaskBoard.getActiveInlineCreate = getActiveInlineCreate;
TaskBoard.getActiveDropdown = getActiveDropdown;
