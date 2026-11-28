/* global document, window, fetch, AbortSignal */
// =============================================================================
// The web dashboard (GET / on the REST server): the app over the REST API,
// same origin, polled every few seconds. The route lives in the hash
// (#/board, #/done, #/stats, #/board/12) so back, forward and links work.
// =============================================================================

import { createApp } from './app.js';
import { detail, snapshot } from './lib/model.js';

const TIMEOUT_MS = 5_000;

async function api(path, init) {
  let res;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error('The server did not answer.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

let me = 'dashboard';

const source = {
  poll: true,
  origin: window.location.origin,
  async load() {
    const [health, board] = await Promise.all([api('/health'), api('/api/board?recent=50')]);
    me = health.user || me;
    return {
      snap: snapshot(board),
      meta: { version: health.version, url: health.dashboard_url, user: health.user },
    };
  },
  async task(id, snap) {
    const t = await api(`/api/tasks/${id}?include=subtasks,comments`);
    const project = typeof t.project === 'string' && t.project ? t.project : null;
    const known = [...(snap?.open ?? []), ...(snap?.recent ?? [])].find(
      (x) => x.id === t.parent_id,
    );
    const [pipeline, parent] = await Promise.all([
      api(`/api/pipeline${project ? `?project=${encodeURIComponent(project)}` : ''}`),
      typeof t.parent_id === 'number' && !known
        ? api(`/api/tasks/${t.parent_id}`).catch(() => null)
        : Promise.resolve(known ?? null),
    ]);
    return detail(t, pipeline.stages, snap, parent);
  },
  act: (id, body) => post(`/api/tasks/${id}/stage`, { ...body, by: me }),
  comment: (id, content) => post(`/api/tasks/${id}/comments`, { content, agent_id: me }),
  create: (fields) => post('/api/tasks', { ...fields, created_by: me }),
  remove: (id) => api(`/api/tasks/${id}`, { method: 'DELETE' }),
};

const TABS = ['board', 'done', 'stats'];

function readHash() {
  const [, tab, id] = window.location.hash.match(/^#\/(\w+)(?:\/(\d+))?/) ?? [];
  return { tab: TABS.includes(tab) ? tab : 'board', taskId: id ? Number(id) : null };
}

const app = createApp(document.getElementById('root'), source, {
  route: {
    write(tab, id) {
      const hash = `#/${tab}${id !== null ? `/${id}` : ''}`;
      if (window.location.hash !== hash) window.history.pushState(null, '', hash);
    },
  },
});
window.addEventListener('popstate', () => {
  const r = readHash();
  app.route(r.tab, r.taskId);
});
app.start(readHash());
