// =============================================================================
// agent-tasks — UI Utilities
//
// Avatar rendering, markdown, escaping, relative time, morphdom wrapper,
// syntax highlighting, diff detection/rendering.
// =============================================================================

window.TaskBoard = window.TaskBoard || {};

// ---- HTML Escaping ----

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

// ---- DOM morphing (morphdom) ----

function morph(el, newInnerHTML) {
  const wrap = document.createElement(el.tagName);
  wrap.innerHTML = newInnerHTML;
  morphdom(el, wrap, {
    childrenOnly: true,
    getNodeKey(node) {
      if (node.id) return node.id;
      if (
        node.dataset &&
        node.dataset.stage &&
        node.classList &&
        node.classList.contains('kanban-column')
      )
        return 'col-' + node.dataset.stage;
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

var AVATAR_COLORS = [
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

// ---- Toast ----

function showToast(title, body, type) {
  const container = TaskBoard._root.getElementById('toast-container');
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

// ---- Register on namespace ----

TaskBoard.esc = esc;
TaskBoard.formatDate = formatDate;
TaskBoard.morph = morph;
TaskBoard.relativeTime = relativeTime;
TaskBoard.avatarColor = avatarColor;
TaskBoard.avatarInitials = avatarInitials;
TaskBoard.renderAvatar = renderAvatar;
TaskBoard.renderMarkdown = renderMarkdown;
TaskBoard.highlightCode = highlightCode;
TaskBoard.highlightSyntax = highlightSyntax;
TaskBoard.detectLanguage = detectLanguage;
TaskBoard.isDiff = isDiff;
TaskBoard.renderDiff = renderDiff;
TaskBoard.showToast = showToast;
