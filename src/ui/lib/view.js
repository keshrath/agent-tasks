// =============================================================================
// A tool result as the widget reads it, and which view it asks for. The data is
// the result's JSON text, the same the model reads (minus the pipeline footer):
// Claude Code gives the model structuredContent in place of the text, so the
// server sends none. Hosts need not tell the widget which tool ran, so the view
// is picked from the shape (pinned by tests/widget.test.ts against real results
// of every widget tool).
// =============================================================================

/** The data of a tool result: its JSON text before the footer, a list as { tasks }. */
export function resultOf(res) {
  const text = (res?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  try {
    const data = JSON.parse(text.split('\n\n---\n')[0]);
    if (Array.isArray(data)) return { tasks: data };
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** 'board' for a task list, 'task' for one task, else null (nothing to draw). */
export function viewOf(sc) {
  if (!sc || typeof sc !== 'object') return null;
  if (Array.isArray(sc.tasks)) return 'board';
  if (typeof sc.id === 'number' && typeof sc.title === 'string' && typeof sc.stage === 'string')
    return 'task';
  return null;
}
