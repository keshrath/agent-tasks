// =============================================================================
// agent-tasks — REST transport
//
// Lightweight HTTP API using only node:http. No framework dependencies.
// Serves both the JSON API and the static web UI.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, realpathSync, existsSync } from 'fs';
import { join, extname, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AppContext } from '../context.js';
import { TasksError, ValidationError } from '../types.js';

const MAX_BODY_SIZE = 65536;

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(req: IncomingMessage, res: ServerResponse): boolean {
  const ip = req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  let entry = rateLimitMap.get(ip);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(ip, entry);
  }

  entry.count++;

  if (entry.count > RATE_LIMIT_MAX) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.ceil((entry.resetAt - now) / 1000)),
      'X-Frame-Options': 'SAMEORIGIN',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    });
    res.end(JSON.stringify({ error: 'Too many requests. Try again later.' }));
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'X-Frame-Options': 'SAMEORIGIN',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
} as const;

const CSP_HEADER =
  "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:";

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new ValidationError('Request body too large (max 64KB).'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (!raw.trim()) {
          resolve({});
          return;
        }
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new ValidationError('Request body must be a JSON object.'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new ValidationError('Invalid JSON in request body.'));
      }
    });

    req.on('error', reject);
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export function createRouter(ctx: AppContext): (req: IncomingMessage, res: ServerResponse) => void {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const routes: Route[] = [];
  const uiDir = resolve(join(__dirname, '..', 'ui'));

  function route(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const pattern = path.replace(/:(\w+)/g, (_match, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    routes.push({ method, pattern: new RegExp(`^${pattern}$`), paramNames, handler });
  }

  function json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      ...SECURITY_HEADERS,
    });
    res.end(JSON.stringify(data));
  }

  // -----------------------------------------------------------------------
  // API routes
  // -----------------------------------------------------------------------

  route('GET', '/health', (_req, res) => {
    json(res, {
      status: 'ok',
      version: pkg.version,
      uptime: process.uptime(),
      tasks: ctx.tasks.list().length,
    });
  });

  route('GET', '/api/tasks', (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    json(
      res,
      ctx.tasks.list({
        status: (url.searchParams.get('status') as 'pending') ?? undefined,
        assigned_to: url.searchParams.get('assigned_to') ?? undefined,
        stage: url.searchParams.get('stage') ?? undefined,
        project: url.searchParams.get('project') ?? undefined,
        limit: url.searchParams.has('limit')
          ? parseInt(url.searchParams.get('limit')!, 10)
          : undefined,
      }),
    );
  });

  route('GET', '/api/tasks/:id', (_req, res, params) => {
    const task = ctx.tasks.getById(parseInt(params.id, 10));
    if (!task) {
      json(res, { error: 'Task not found' }, 404);
      return;
    }
    json(res, task);
  });

  route('GET', '/api/tasks/:id/artifacts', (req, res, params) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const stage = url.searchParams.get('stage') ?? undefined;
    try {
      json(res, ctx.tasks.getArtifacts(parseInt(params.id, 10), stage));
    } catch (err) {
      if (err instanceof TasksError) {
        json(res, { error: err.message }, err.statusCode);
      } else {
        json(res, { error: 'Internal error' }, 500);
      }
    }
  });

  route('GET', '/api/tasks/:id/dependencies', (_req, res, params) => {
    try {
      json(res, ctx.tasks.getDependencies(parseInt(params.id, 10)));
    } catch (err) {
      if (err instanceof TasksError) {
        json(res, { error: err.message }, err.statusCode);
      } else {
        json(res, { error: 'Internal error' }, 500);
      }
    }
  });

  route('GET', '/api/dependencies', (_req, res) => {
    json(res, ctx.tasks.getAllDependencies());
  });

  route('GET', '/api/pipeline', (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const project = url.searchParams.get('project') ?? undefined;
    json(res, { stages: ctx.tasks.getPipelineStages(project) });
  });

  route('GET', '/api/overview', (_req, res) => {
    json(res, {
      tasks: ctx.tasks.list(),
      dependencies: ctx.tasks.getAllDependencies(),
      artifactCounts: ctx.tasks.getArtifactCounts(),
      commentCounts: ctx.comments.countByTask(),
      subtaskProgress: ctx.tasks.getAllSubtaskProgress(),
      stages: ctx.tasks.getPipelineStages(),
    });
  });

  route('POST', '/api/tasks', async (req, res) => {
    try {
      const body = await parseBody(req);
      const task = ctx.tasks.create(
        {
          title: body.title as string,
          description: body.description as string | undefined,
          assign_to: body.assign_to as string | undefined,
          stage: body.stage as string | undefined,
          priority: body.priority as number | undefined,
          project: body.project as string | undefined,
          tags: body.tags as string[] | undefined,
          parent_id: body.parent_id as number | undefined,
        },
        (body.created_by as string) || 'api',
      );
      json(res, task, 201);
    } catch (err) {
      if (err instanceof TasksError) {
        json(res, { error: err.message }, err.statusCode);
      } else {
        json(res, { error: 'Internal error' }, 500);
      }
    }
  });

  route('PUT', '/api/tasks/:id/stage', async (req, res, params) => {
    try {
      const body = await parseBody(req);
      const taskId = parseInt(params.id, 10);
      const targetStage = body.stage as string;
      const task = ctx.tasks.getById(taskId);
      if (!task) {
        json(res, { error: 'Task not found' }, 404);
        return;
      }
      const stages = ctx.tasks.getPipelineStages(task.project ?? undefined);
      const currentIdx = stages.indexOf(task.stage);
      const targetIdx = stages.indexOf(targetStage);
      if (targetIdx > currentIdx) {
        json(res, ctx.tasks.advance(taskId, targetStage));
      } else if (targetIdx < currentIdx) {
        json(res, ctx.tasks.regress(taskId, targetStage, body.reason as string | undefined));
      } else {
        json(res, task);
      }
    } catch (err) {
      if (err instanceof TasksError) {
        json(res, { error: err.message }, err.statusCode);
      } else {
        json(res, { error: 'Internal error' }, 500);
      }
    }
  });

  route('GET', '/api/tasks/:id/subtasks', (_req, res, params) => {
    try {
      json(res, ctx.tasks.getSubtasks(parseInt(params.id, 10)));
    } catch (err) {
      if (err instanceof TasksError) {
        json(res, { error: err.message }, err.statusCode);
      } else {
        json(res, { error: 'Internal error' }, 500);
      }
    }
  });

  route('GET', '/api/tasks/:id/comments', (_req, res, params) => {
    try {
      json(res, ctx.comments.list(parseInt(params.id, 10)));
    } catch (err) {
      if (err instanceof TasksError) {
        json(res, { error: err.message }, err.statusCode);
      } else {
        json(res, { error: 'Internal error' }, 500);
      }
    }
  });

  route('POST', '/api/tasks/:id/comments', async (req, res, params) => {
    try {
      const body = await parseBody(req);
      const comment = ctx.comments.add(
        parseInt(params.id, 10),
        (body.agent_id as string) || 'api',
        body.content as string,
        body.parent_comment_id as number | undefined,
      );
      json(res, comment, 201);
    } catch (err) {
      if (err instanceof TasksError) {
        json(res, { error: err.message }, err.statusCode);
      } else {
        json(res, { error: 'Internal error' }, 500);
      }
    }
  });

  route('GET', '/api/agents', async (_req, res) => {
    try {
      const agents = await ctx.agentBridge.fetchAgents();
      json(res, agents);
    } catch {
      json(res, []);
    }
  });

  route('POST', '/api/cleanup', async (req, res) => {
    try {
      const body = await parseBody(req);
      const result = body.force ? ctx.cleanup.purgeAll() : ctx.cleanup.run();
      json(res, result);
    } catch (err) {
      if (err instanceof TasksError) {
        json(res, { error: err.message }, err.statusCode);
      } else {
        json(res, { error: 'Internal error' }, 500);
      }
    }
  });

  route('GET', '/api/search', (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const query = url.searchParams.get('q') ?? '';
    try {
      json(
        res,
        ctx.tasks.search(query, {
          project: url.searchParams.get('project') ?? undefined,
          limit: url.searchParams.has('limit')
            ? parseInt(url.searchParams.get('limit')!, 10)
            : undefined,
        }),
      );
    } catch (err) {
      if (err instanceof TasksError) {
        json(res, { error: err.message }, err.statusCode);
      } else {
        json(res, { error: 'Internal error' }, 500);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Static file serving
  // -----------------------------------------------------------------------

  function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    let pathname = new URL(req.url!, `http://${req.headers.host}`).pathname;

    if (pathname === '/' || pathname === '') pathname = '/index.html';

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

    if (decoded.includes('\0') || decoded.includes('..')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const filePath = join(uiDir, decoded);

    let realPath: string;
    try {
      realPath = realpathSync(filePath);
    } catch {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const realUiDir = realpathSync(uiDir);
    if (!realPath.startsWith(realUiDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const content = readFileSync(realPath);
      const ext = extname(realPath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': CSP_HEADER,
        ...SECURITY_HEADERS,
      });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end('Internal error');
    }
  }

  // -----------------------------------------------------------------------
  // Request dispatcher
  // -----------------------------------------------------------------------

  return (req: IncomingMessage, res: ServerResponse) => {
    if (!checkRateLimit(req, res)) return;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url!, `http://${req.headers.host}`);
    const pathname = url.pathname;

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = pathname.match(r.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });

      try {
        const result = r.handler(req, res, params);
        if (result instanceof Promise) {
          result.catch((err) => {
            if (!res.writableEnded) {
              if (err instanceof TasksError) {
                json(res, { error: err.message }, err.statusCode);
              } else {
                json(res, { error: 'Internal error' }, 500);
              }
            }
          });
        }
      } catch (err) {
        if (!res.writableEnded) {
          if (err instanceof TasksError) {
            json(res, { error: err.message }, err.statusCode);
          } else {
            json(res, { error: 'Internal error' }, 500);
          }
        }
      }
      return;
    }

    if (req.method === 'GET' && existsSync(uiDir)) {
      serveStatic(req, res);
    } else {
      json(res, { error: 'Not found' }, 404);
    }
  };
}
