// =============================================================================
// agent-tasks — WebSocket transport
//
// Real-time event streaming to connected UI clients.
// Full state sent on connect. Uses DB polling (2s) to detect changes
// from other MCP processes, since each has its own in-memory EventBus.
// =============================================================================

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AppContext } from '../context.js';
import type { EventType } from '../types.js';

const __dirname_ws = dirname(fileURLToPath(import.meta.url));
const pkgVersion: string = JSON.parse(
  readFileSync(join(__dirname_ws, '..', '..', 'package.json'), 'utf8'),
).version;

const MAX_WS_MESSAGE_SIZE = 4096;
const MAX_WS_CONNECTIONS = 50;
const PING_INTERVAL_MS = 30_000;
const DB_POLL_INTERVAL_MS = 2_000;

export interface WebSocketHandle {
  wss: WebSocketServer;
  broadcast(message: string): void;
  close(): void;
}

interface ClientState {
  alive: boolean;
  subscribedEvents: Set<EventType | '*'>;
}

const VALID_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  '*',
  'task:created',
  'task:updated',
  'task:claimed',
  'task:advanced',
  'task:regressed',
  'task:completed',
  'task:failed',
  'task:cancelled',
  'task:deleted',
  'artifact:created',
  'dependency:added',
  'dependency:removed',
  'pipeline:configured',
  'comment:created',
  'collaborator:added',
  'collaborator:removed',
  'approval:requested',
  'approval:approved',
  'approval:rejected',
]);

export function setupWebSocket(httpServer: Server, ctx: AppContext): WebSocketHandle {
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_WS_MESSAGE_SIZE });
  const clients = new Map<WebSocket, ClientState>();

  wss.on('connection', (ws: WebSocket) => {
    if (wss.clients.size > MAX_WS_CONNECTIONS) {
      ws.close(1013, 'Too many connections');
      return;
    }

    const state: ClientState = {
      alive: true,
      subscribedEvents: new Set(),
    };
    clients.set(ws, state);

    sendFullState(ws, ctx);

    ws.on('pong', () => {
      state.alive = true;
    });

    ws.on('message', (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Message must be a JSON object' }));
        return;
      }

      const msg = parsed as { type: string; [key: string]: unknown };

      if (typeof msg.type !== 'string') {
        ws.send(JSON.stringify({ type: 'error', message: 'Missing type field' }));
        return;
      }

      switch (msg.type) {
        case 'refresh':
          sendFullState(ws, ctx);
          break;

        case 'subscribe': {
          const events = msg.events;
          if (!Array.isArray(events)) {
            ws.send(
              JSON.stringify({
                type: 'error',
                message: '"events" must be an array of event type strings',
              }),
            );
            break;
          }
          state.subscribedEvents.clear();
          for (const e of events) {
            if (typeof e === 'string' && VALID_EVENT_TYPES.has(e)) {
              state.subscribedEvents.add(e as EventType | '*');
            }
          }
          ws.send(JSON.stringify({ type: 'subscribed', events: [...state.subscribedEvents] }));
          break;
        }

        default: {
          const safeType = String(msg.type)
            .slice(0, 64)
            .replace(/[<>&"']/g, '');
          ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${safeType}` }));
        }
      }
    });

    ws.on('error', () => {
      clients.delete(ws);
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  const pingInterval = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  pingInterval.unref();

  // Poll DB for changes from other processes (MCP stdio servers write directly).
  // Computes a lightweight fingerprint of tasks and pushes full state on change.
  let lastFingerprint = '';
  const dbPollInterval = setInterval(() => {
    if (clients.size === 0) return;
    try {
      const row = ctx.db.queryOne<{ fp: string }>(
        `SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at),'') || ':' || COALESCE(MAX(id),0) as fp FROM tasks`,
      );
      const fp = row?.fp ?? '';
      if (fp !== lastFingerprint) {
        lastFingerprint = fp;
        for (const [ws] of clients) {
          if (ws.readyState === WebSocket.OPEN) {
            sendFullState(ws, ctx);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }, DB_POLL_INTERVAL_MS);
  dbPollInterval.unref();

  return {
    wss,
    broadcast(message: string): void {
      for (const [ws] of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        }
      }
    },
    close() {
      clearInterval(pingInterval);
      clearInterval(dbPollInterval);
      for (const [ws] of clients) {
        ws.close(1001, 'Server shutting down');
      }
      clients.clear();
      wss.close();
    },
  };
}

function sendFullState(ws: WebSocket, ctx: AppContext): void {
  try {
    ws.send(
      JSON.stringify({
        type: 'state',
        version: pkgVersion,
        tasks: ctx.tasks.list(),
        dependencies: ctx.tasks.getAllDependencies(),
        artifactCounts: ctx.tasks.getArtifactCounts(),
        commentCounts: ctx.comments.countByTask(),
        subtaskProgress: ctx.tasks.getAllSubtaskProgress(),
        stages: ctx.tasks.getPipelineStages(),
      }),
    );
  } catch {
    /* ignore send errors on closed sockets */
  }
}
