// =============================================================================
// agent-tasks — Request guard (every HTTP request)
//
//   - Host must exactly equal one of the loopback names with the server's port
//     (localhost:P, 127.0.0.1:P, [::1]:P), plus the bound host when the
//     operator binds elsewhere (AGENT_TASKS_HOST). Defeats DNS rebinding.
//   - Any Origin is rejected, loopback ones included: only browsers send it and
//     no browser page is a caller (the /pipeline pane and the hook scripts are
//     not browsers). No CORS headers, so no page can read a response.
//   - Requests with a body on POST/PUT/PATCH/DELETE must be application/json,
//     so CORS-safelisted form posts never reach a handler.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'http';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Applies the policy; true when the request was answered (rejected). */
export type RequestGuard = (req: IncomingMessage, res: ServerResponse) => boolean;

function reject(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify({ error }));
}

export function createRequestGuard(port: number, bindHost = '127.0.0.1'): RequestGuard {
  const names = new Set(LOOPBACK);
  if (!['0.0.0.0', '::', '[::]'].includes(bindHost)) {
    names.add(bindHost.includes(':') && !bindHost.startsWith('[') ? `[${bindHost}]` : bindHost);
  }
  const hosts = new Set([...names].map((h) => `${h.toLowerCase()}:${port}`));

  return (req, res) => {
    const host = req.headers.host?.toLowerCase();
    if (!host || !hosts.has(host)) {
      reject(res, 403, 'Forbidden host');
      return true;
    }
    if (req.headers.origin !== undefined) {
      reject(res, 403, 'Forbidden origin');
      return true;
    }
    const length = req.headers['content-length'];
    const hasBody =
      (length !== undefined && length !== '0') || req.headers['transfer-encoding'] !== undefined;
    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (MUTATING.has(req.method ?? '') && hasBody && type !== 'application/json') {
      reject(res, 415, 'Content-Type must be application/json');
      return true;
    }
    return false;
  };
}
