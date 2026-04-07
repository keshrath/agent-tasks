#!/usr/bin/env node

// =============================================================================
// agent-tasks — HTTP + WebSocket server entry point
//
// Standalone web server for the pipeline dashboard and REST API.
// Can be started manually: node dist/server.js [--port 3422]
// Or auto-started from the MCP server via leader election.
// Built on agent-common's startDashboard for the leader-election + EADDRINUSE
// handling boilerplate. The UI file watcher is wired in onListen.
// =============================================================================

import {
  startDashboard as startKitDashboard,
  type DashboardServer as KitDashboard,
} from 'agent-common';
import type { Server } from 'http';
import { watch } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createContext, type AppContext } from './context.js';
import { createRouter } from './transport/rest.js';
import { setupWebSocket, type WebSocketHandle } from './transport/ws.js';
import type { DbOptions } from './storage/database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DashboardServer {
  httpServer: Server;
  port: number;
  close(): void;
}

function getCliArgAfterFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

export async function startDashboard(ctx: AppContext, port = 3422): Promise<DashboardServer> {
  const router = createRouter(ctx);
  let wsHandle: WebSocketHandle | null = null;
  let fileWatcher: ReturnType<typeof startFileWatcher> | null = null;

  const kit: KitDashboard = await startKitDashboard({
    port,
    handler: router,
    onListen: (httpServer) => {
      wsHandle = setupWebSocket(httpServer, ctx);
      fileWatcher = startFileWatcher(wsHandle);
      return {
        close() {
          if (fileWatcher) fileWatcher.close();
          if (wsHandle) wsHandle.close();
        },
      };
    },
    banner: (p) => `agent-tasks dashboard: http://localhost:${p}`,
  });

  return {
    httpServer: kit.httpServer,
    port: kit.port,
    close() {
      kit.close();
    },
  };
}

// ---------------------------------------------------------------------------
// UI file watcher — triggers livereload on connected clients
// ---------------------------------------------------------------------------

function startFileWatcher(wsHandle: WebSocketHandle) {
  const uiDir = resolve(join(__dirname, 'ui'));
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(uiDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      wsHandle.broadcast(JSON.stringify({ type: 'reload' }));
    }, 200);
  });

  return {
    close() {
      if (debounce) clearTimeout(debounce);
      watcher.close();
    },
  };
}

if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  const port = parseInt(getCliArgAfterFlag(process.argv, '--port') ?? '3422', 10);
  const dbPath = getCliArgAfterFlag(process.argv, '--db');
  const dbOptions: DbOptions = dbPath ? { path: dbPath } : {};

  const ctx = createContext(dbOptions);
  startDashboard(ctx, port)
    .then((dashboardServer) => {
      process.on('SIGINT', () => {
        dashboardServer.close();
        ctx.close();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        dashboardServer.close();
        ctx.close();
        process.exit(0);
      });
    })
    .catch((err) => {
      process.stderr.write(`Failed to start dashboard: ${err.message}\n`);
      process.exit(1);
    });
}
