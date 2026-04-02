// =============================================================================
// agent-tasks — Drag and Drop Module
//
// Drag-and-drop logic, auto-scroll during drag.
// =============================================================================

window.TaskBoard = window.TaskBoard || {};

var draggedTaskId = null;
var dragScrollInterval = null;
var _lastMouseX = 0;

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
  TaskBoard._root
    .querySelectorAll('.kanban-column.drag-over')
    .forEach((c) => c.classList.remove('drag-over'));
  TaskBoard._root.querySelectorAll('.drop-placeholder').forEach((p) => p.remove());
  const board = TaskBoard._root.getElementById('board');
  board.classList.remove('drag-scroll-left', 'drag-scroll-right');
}

function onDragOver(e, col) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (col && !col.classList.contains('drag-over')) {
    TaskBoard._root
      .querySelectorAll('.kanban-column.drag-over')
      .forEach((c) => c.classList.remove('drag-over'));
    col.classList.add('drag-over');
  }
}

function onDrop(e, col) {
  var state = TaskBoard.state;
  var showToast = TaskBoard.showToast;

  e.preventDefault();
  if (col) col.classList.remove('drag-over');
  TaskBoard._root.querySelectorAll('.drop-placeholder').forEach((p) => p.remove());

  if (!draggedTaskId) return;
  const targetStage = col.dataset.stage;
  const task = state.tasks.find((t) => t.id === draggedTaskId);
  if (!task || task.stage === targetStage) return;

  TaskBoard._fetch(`/api/tasks/${draggedTaskId}/stage`, {
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
  const board = TaskBoard._root.getElementById('board');
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

// ---- Drag event wiring ----

function initDragEvents() {
  var board = TaskBoard._root.getElementById('board');

  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.task-card[data-task-id]');
    if (card) onDragStart(e, card);
  });

  board.addEventListener('dragend', (e) => {
    onDragEnd(e);
  });

  board.addEventListener('dragover', (e) => {
    const col = e.target.closest('.kanban-column');
    if (col) onDragOver(e, col);
  });

  board.addEventListener('dragleave', (e) => {
    const col = e.target.closest('.kanban-column');
    if (col && !col.contains(e.relatedTarget)) {
      col.classList.remove('drag-over');
    }
  });

  board.addEventListener('drop', (e) => {
    const col = e.target.closest('.kanban-column');
    if (col) onDrop(e, col);
  });

  document.addEventListener('dragover', (e) => {
    _lastMouseX = e.clientX;
  });
}

// ---- Register on namespace ----

TaskBoard.initDragEvents = initDragEvents;
