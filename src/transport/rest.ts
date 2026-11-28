// =============================================================================
// agent-tasks — REST transport
//
// Lightweight HTTP API using only node:http. No framework dependencies.
// The JSON API the Claude Code plugin (the /pipeline pane and its session hooks) and
// the web dashboard call, and the dashboard itself (GET /, built into dist/ui by
// src/ui/build.mjs) under a CSP that allows only its own script, style and API.
// Host, Origin and Content-Type are checked by the request guard (guard.ts)
// before a request reaches the router.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AppContext } from '../context.js';
import { readPackageMeta } from '../package-meta.js';
import { TasksError, ValidationError } from '../types.js';
import { validateHolder } from '../domain/holders.js';
import {
  handleArtifact,
  handleCreate,
  handleGet,
  handleStage,
  type SessionState,
} from './mcp-handlers.js';

const MAX_BODY_SIZE = 131_072;

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

const UI_DIR = new URL('../../dist/ui/', import.meta.url);
const ASSETS: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Who acts from the dashboard: AGENT_TASKS_USER, else the OS user (as the pane does). */
function dashboardUser(): string {
  try {
    return process.env.AGENT_TASKS_USER || userInfo().username;
  } catch {
    return 'dashboard';
  }
}

function asset(res: ServerResponse, path: string): void {
  const [file, type] = ASSETS[path]!;
  let body: Buffer;
  try {
    body = readFileSync(fileURLToPath(new URL(file, UI_DIR)));
  } catch {
    json(res, { error: 'The dashboard is not built (npm run build).' }, 503);
    return;
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

/** The request's JSON object body, at most MAX_BODY_SIZE bytes. */
function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) reject(new ValidationError('Request body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
        if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
          resolve(body as Record<string, unknown>);
        } else reject(new ValidationError('Request body must be a JSON object'));
      } catch {
        reject(new ValidationError('Invalid JSON in request body'));
      }
    });
    req.on('error', reject);
  });
}

/** Who acts, from `body[key]`; a claim made over REST is held by nothing (`/api/holders`). */
function actor(body: Record<string, unknown>, key: string): SessionState {
  const given = body[key];
  const name = typeof given === 'string' && given ? given : 'api';
  return { current: { id: name, name }, holder: null };
}

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  url: URL,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export function createRouter(ctx: AppContext): (req: IncomingMessage, res: ServerResponse) => void {
  const pkg = readPackageMeta();
  const routes: Route[] = [];

  function route(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const pattern = path.replace(/\./g, '\\.').replace(/:(\w+)/g, (_match, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    routes.push({ method, pattern: new RegExp(`^${pattern}$`), paramNames, handler });
  }

  function parseId(params: Record<string, string>): number {
    const n = parseInt(params.id, 10);
    if (Number.isNaN(n)) throw new ValidationError('Invalid id: must be an integer.');
    return n;
  }

  // -----------------------------------------------------------------------
  // API routes
  // -----------------------------------------------------------------------

  for (const path of Object.keys(ASSETS)) route('GET', path, (_req, res) => asset(res, path));

  route('GET', '/health', (req, res) => {
    json(res, {
      status: 'ok',
      version: pkg.version,
      uptime: process.uptime(),
      tasks: ctx.tasks.count(),
      dashboard_url: `http://${req.headers.host}/`,
      user: dashboardUser(),
    });
  });

  route('POST', '/api/tasks', async (req, res) => {
    const body = await parseBody(req);
    json(res, handleCreate(ctx, body, actor(body, 'created_by')), 201);
  });

  route('GET', '/api/tasks/:id', (_req, res, params, url) => {
    const include = url.searchParams.getAll('include').flatMap((v) => v.split(','));
    json(res, handleGet(ctx, { task_id: parseId(params), include }));
  });

  // A host's own session as a claim holder: POST beats (alive now), adopts the open
  // tasks in `adopt` and answers the open tasks it holds; DELETE says the session ended.
  route('POST', '/api/holders/:holder', async (req, res, params) => {
    const body = await parseBody(req);
    const holder = validateHolder(params.holder);
    const ids = Array.isArray(body.adopt) ? body.adopt.map(Number).filter(Number.isInteger) : [];
    const adopted = ctx.holders.adopt(holder, ids);
    json(res, { adopted, held: ctx.holders.held(holder) });
  });

  route('DELETE', '/api/holders/:holder', (_req, res, params) => {
    ctx.holders.end(validateHolder(params.holder));
    json(res, { ok: true });
  });

  route('DELETE', '/api/tasks/:id', (_req, res, params) => {
    ctx.tasks.delete(parseId(params));
    json(res, { ok: true });
  });

  // task_stage over REST: { action, claimer?, stage?, comment?, reason?, result?, by? }.
  // `by` names who acts (an advance comment, a rejection); the claimer defaults to it.
  route('POST', '/api/tasks/:id/stage', async (req, res, params) => {
    const body = await parseBody(req);
    json(res, handleStage(ctx, { ...body, task_id: parseId(params) }, actor(body, 'by')));
  });

  route('POST', '/api/tasks/:id/comments', async (req, res, params) => {
    const body = await parseBody(req);
    const comment = handleArtifact(
      ctx,
      { ...body, type: 'comment', task_id: parseId(params) },
      actor(body, 'agent_id'),
    );
    json(res, comment, 201);
  });

  route('GET', '/api/pipeline', (_req, res, _params, url) => {
    const project = url.searchParams.get('project') ?? undefined;
    json(res, {
      stages: ctx.tasks.getPipelineStages(project),
      gate_config: ctx.tasks.getGateConfig(project),
    });
  });

  // Every open task plus the most recently closed ones, with what a board row shows.
  route('GET', '/api/board', (_req, res, _params, url) => {
    const recentLimit = url.searchParams.has('recent')
      ? parseInt(url.searchParams.get('recent')!, 10) || 30
      : 30;
    const open = [
      ...ctx.tasks.list({ status: 'in_progress' }),
      ...ctx.tasks.list({ status: 'pending' }),
    ];
    const recent = ctx.tasks.listRecentlyClosed(recentLimit);
    const defaults = ctx.tasks.getPipelineStages();
    const pipelines: Record<string, string[]> = {};
    for (const project of new Set(open.map((t) => t.project).filter((p) => p !== null))) {
      const stages = ctx.tasks.getPipelineStages(project);
      if (stages.join('\n') !== defaults.join('\n')) pipelines[project] = stages;
    }
    json(res, {
      stages: defaults,
      pipelines,
      open,
      recent,
      dependencies: ctx.tasks.getDependenciesForTasks(open.map((t) => t.id)),
      subtaskProgress: ctx.tasks.getSubtaskProgressForTasks(open.map((t) => t.id)),
    });
  });

  // -----------------------------------------------------------------------
  // Request dispatcher
  // -----------------------------------------------------------------------

  function fail(res: ServerResponse, err: unknown): void {
    if (res.writableEnded) return;
    if (err instanceof TasksError) json(res, { error: err.message }, err.statusCode);
    else json(res, { error: 'Internal error' }, 500);
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = url.pathname.match(r.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      try {
        r.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
      } catch {
        json(res, { error: 'Malformed URL encoding in path parameter.' }, 400);
        return;
      }

      Promise.resolve()
        .then(() => r.handler(req, res, params, url))
        .catch((err) => fail(res, err));
      return;
    }

    json(res, { error: 'Not found' }, 404);
  };
}
