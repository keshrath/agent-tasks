// =============================================================================
// agent-tasks — MCP Apps wiring
//
// One self-contained widget (src/ui/widget.js, built to dist/ui/widget.html by
// src/ui/build.mjs) draws the results of the widget tools inline in MCP Apps
// hosts (Claude Desktop, claude.ai, VS Code, ...): a task list as the board, one
// task as its detail, both read from the result's JSON text (src/ui/lib/view.js).
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const WIDGET_URI = 'ui://agent-tasks/app.html';
/** ext-apps RESOURCE_MIME_TYPE (pinned by tests/widget.test.ts). */
export const WIDGET_MIME = 'text/html;profile=mcp-app';

/** Tools whose results the widget draws. */
export const WIDGET_TOOLS: ReadonlySet<string> = new Set(['task_list', 'task_get', 'task_create']);

/** Tool `_meta` that points MCP Apps hosts at the widget (nested form + the legacy flat key). */
export const WIDGET_META = { ui: { resourceUri: WIDGET_URI }, 'ui/resourceUri': WIDGET_URI };

export const WIDGET_RESOURCE = {
  uri: WIDGET_URI,
  name: 'agent-tasks-app',
  title: 'agent-tasks',
  description:
    'The agent-tasks board and task detail, drawn from task_list, task_get and task_create',
  mimeType: WIDGET_MIME,
};

const HTML = fileURLToPath(new URL('../../dist/ui/widget.html', import.meta.url));
let cached: string | undefined;

export function widgetHtml(): string {
  cached ??= readFileSync(HTML, 'utf8');
  return cached;
}
