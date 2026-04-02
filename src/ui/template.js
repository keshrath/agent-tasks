// =============================================================================
// agent-tasks — Template Module
//
// HTML template for plugin mount mode. Extracted from index.html body content.
// =============================================================================

window.TaskBoard = window.TaskBoard || {};

TaskBoard._template = function () {
  return (
    '<header role="banner">' +
    '<div class="header-left">' +
    '<span class="material-symbols-outlined brand-icon">view_kanban</span>' +
    '<h1>agent-tasks</h1>' +
    '<span class="version" id="version"></span>' +
    '<span id="connection-status" class="status-badge disconnected" role="status" aria-live="polite">Connecting</span>' +
    '</div>' +
    '<div class="header-right">' +
    '<div class="stats" id="stats" aria-live="polite" aria-atomic="true"></div>' +
    '<button id="cleanup-btn" class="icon-btn" title="Clean up" aria-label="Clean up old tasks">' +
    '<span class="material-symbols-outlined">mop</span>' +
    '</button>' +
    '<button id="theme-toggle" class="icon-btn" title="Toggle theme" aria-label="Toggle theme">' +
    '<span class="material-symbols-outlined theme-icon">dark_mode</span>' +
    '</button>' +
    '</div>' +
    '</header>' +
    '<div class="filter-bar" id="filter-bar" role="search" aria-label="Task filters">' +
    '<div class="filter-group">' +
    '<span class="material-symbols-outlined filter-icon" aria-hidden="true">filter_list</span>' +
    '<input type="text" id="filter-search" class="filter-input" placeholder="Search tasks... (/ or Ctrl+K)" autocomplete="off" aria-label="Search tasks" />' +
    '<select id="filter-project" class="filter-select" aria-label="Filter by project">' +
    '<option value="">All projects</option>' +
    '</select>' +
    '<select id="filter-assignee" class="filter-select" aria-label="Filter by assignee">' +
    '<option value="">All assignees</option>' +
    '</select>' +
    '<select id="filter-priority" class="filter-select" aria-label="Filter by minimum priority">' +
    '<option value="">Any priority</option>' +
    '<option value="1">P1+</option>' +
    '<option value="3">P3+</option>' +
    '<option value="5">P5+</option>' +
    '<option value="10">P10+</option>' +
    '</select>' +
    '</div>' +
    '<div class="filter-chips" id="filter-chips"></div>' +
    '</div>' +
    '<div class="board-wrapper" id="board-wrapper">' +
    '<main id="board" class="kanban-board" role="region" aria-label="Task board"></main>' +
    '<aside id="side-panel" class="side-panel" role="complementary" aria-label="Task details">' +
    '<div class="panel-header" id="panel-header-content"></div>' +
    '<div class="panel-body" id="panel-body"></div>' +
    '</aside>' +
    '</div>' +
    '<div id="loading-overlay" class="loading-overlay" aria-label="Loading">' +
    '<div class="loading-spinner"></div>' +
    '<div class="loading-text">Connecting to agent-tasks...</div>' +
    '</div>' +
    '<div id="task-modal" class="modal-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="modal-title">' +
    '<div class="modal">' +
    '<div class="modal-header">' +
    '<h2 id="modal-title"></h2>' +
    '<button class="icon-btn modal-close" id="modal-close-btn" aria-label="Close dialog">&times;</button>' +
    '</div>' +
    '<div id="modal-body" class="modal-body"></div>' +
    '</div>' +
    '</div>' +
    '<div id="cleanup-modal" class="modal-overlay hidden" role="dialog" aria-modal="true">' +
    '<div class="modal" style="max-width: 420px">' +
    '<div class="modal-header">' +
    '<h2><span class="material-symbols-outlined" style="font-size: 20px; vertical-align: middle; margin-right: 6px">mop</span>Clean Up</h2>' +
    '<button class="icon-btn modal-close" id="cleanup-close-btn" aria-label="Close">&times;</button>' +
    '</div>' +
    '<div class="modal-body">' +
    '<p style="color: var(--text-muted); margin-bottom: 12px">Remove old tasks and stale data:</p>' +
    '<div class="cleanup-options">' +
    '<button id="cleanup-completed" class="cleanup-option">' +
    '<span class="material-symbols-outlined">auto_delete</span>' +
    '<div><strong>Purge completed</strong><span>Remove all completed and cancelled tasks</span></div>' +
    '</button>' +
    '<button id="cleanup-everything" class="cleanup-option cleanup-option-danger">' +
    '<span class="material-symbols-outlined">delete_forever</span>' +
    '<div><strong>Purge everything</strong><span>Remove ALL tasks regardless of status</span></div>' +
    '</button>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div id="toast-container" class="toast-container" aria-live="polite"></div>'
  );
};
