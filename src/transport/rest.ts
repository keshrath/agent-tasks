// =============================================================================
// agent-tasks — REST transport
//
// Lightweight HTTP API using only node:http. No framework dependencies.
// The JSON API the Claude Code /pipeline pane and the hook scripts call.
// Host, Origin and Content-Type are checked by the request guard (guard.ts)
// before a request reaches the router.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'http';
import type { AppContext } from '../context.js';
import { readPackageMeta } from '../package-meta.js';
import { TasksError, ValidationError } from '../types.js';
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

function actor(body: Record<string, unknown>, key: string): SessionState {
  const given = body[key];
  const name = typeof given === 'string' && given ? given : 'api';
  return { current: { id: name, name } };
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
    const pattern = path.replace(/:(\w+)/g, (_match, name) => {
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

  route('GET', '/health', (_req, res) => {
    json(res, {
      status: 'ok',
      version: pkg.version,
      uptime: process.uptime(),
      tasks: ctx.tasks.count(),
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
