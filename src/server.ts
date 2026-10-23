#!/usr/bin/env node

// =============================================================================
// agent-tasks — REST server entry point
//
// The local REST API the Claude Code /pipeline pane and the hook scripts read.
// Can be started manually: node dist/server.js [--port 3422] [--db path]
// Or auto-started from the MCP server via leader election: the first process
// to bind the port serves it, the others retry, so one of them takes over when
// the serving process exits. Built on agent-common's startDashboard for the
// bind, request guard and EADDRINUSE handling.
// =============================================================================

import { startDashboard as startKitServer } from 'agent-common';
import type { Server } from 'http';
import { createContext, type AppContext } from './context.js';
import { createRouter } from './transport/rest.js';
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

export function startRestServer(ctx: AppContext, port = 3422): Promise<RestServer> {
  return startKitServer({
    port,
    host: process.env.AGENT_TASKS_HOST,
    handler: createRouter(ctx),
    banner: (p) => `agent-tasks REST API: http://localhost:${p}`,
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
