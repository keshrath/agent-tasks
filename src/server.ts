#!/usr/bin/env node

// =============================================================================
// agent-tasks — REST server entry point
//
// The local REST API the Claude Code plugin (the /pipeline pane and its session hooks) reads.
// Can be started manually: node dist/server.js [--port 3422] [--db path]
// Or auto-started from the MCP server via leader election: the first process
// to bind the port serves it, the others retry, so one of them takes over when
// the serving process exits. Binds 127.0.0.1 (AGENT_TASKS_HOST overrides) and
// runs every request through the request guard.
// =============================================================================

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createContext, type AppContext } from './context.js';
import { createRouter } from './transport/rest.js';
import { createRequestGuard, type RequestGuard } from './transport/guard.js';
import type { DbOptions } from './storage/database.js';

export interface RestServer {
  httpServer: Server;
  port: number;
  close(): void;
}

function getCliArgAfterFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

/** Listens on `port` (0 picks a free one); rejects with code EADDRINUSE when it is taken. */
export function startRestServer(ctx: AppContext, port = 3422): Promise<RestServer> {
  const host = process.env.AGENT_TASKS_HOST || '127.0.0.1';
  const route = createRouter(ctx);
  let guard: RequestGuard;
  const httpServer = createServer((req, res) => {
    if (!guard(req, res)) route(req, res);
  });
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const bound = (httpServer.address() as AddressInfo).port;
      guard = createRequestGuard(bound, host);
      process.stderr.write(`agent-tasks REST API: http://localhost:${bound}\n`);
      resolve({ httpServer, port: bound, close: () => httpServer.close() });
    });
  });
}

export interface RestLeader {
  /** The server while this process holds the port, else null. */
  readonly server: RestServer | null;
  close(): void;
}

/**
 * Serves REST on `port` from whichever process holds it. A process that finds the port
 * taken tries again every `retryMs`, so the board stays up when the serving one exits.
 */
export function serveRestWhenFree(ctx: AppContext, port: number, retryMs = 5_000): RestLeader {
  let server: RestServer | null = null;
  let timer: NodeJS.Timeout | null = null;
  let isClosed = false;
  const attempt = () => {
    startRestServer(ctx, port).then(
      (s) => {
        if (isClosed) s.close();
        else server = s;
      },
      (err: NodeJS.ErrnoException) => {
        if (isClosed) return;
        if (err.code !== 'EADDRINUSE') {
          process.stderr.write(`[agent-tasks] REST server start failed: ${err.message}\n`);
          return;
        }
        timer = setTimeout(attempt, retryMs);
        timer.unref();
      },
    );
  };
  attempt();

  return {
    get server() {
      return server;
    },
    close() {
      isClosed = true;
      if (timer) clearTimeout(timer);
      server?.close();
    },
  };
}

if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  const port = parseInt(getCliArgAfterFlag(process.argv, '--port') ?? '3422', 10);
  const dbPath = getCliArgAfterFlag(process.argv, '--db');
  const dbOptions: DbOptions = dbPath ? { path: dbPath } : {};

  const ctx = createContext(dbOptions);
  startRestServer(ctx, port)
    .then((server) => {
      const stop = () => {
        server.close();
        ctx.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err) => {
      process.stderr.write(`Failed to start the REST server: ${err.message}\n`);
      process.exit(1);
    });
}
