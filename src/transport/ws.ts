// =============================================================================
// agent-tasks — WebSocket transport
//
// Thin wrapper around agent-common's setupWebSocket. Streams full state on
// any DB change (single scalar fingerprint over tasks + comments + artifacts).
// Custom `subscribe` message type is handled via the onMessage callback;
// per-client subscribed-event filters are stored in a side Map keyed by
// WebSocket. The underlying broadcast() method is re-exposed for the UI
// file watcher (hot reload).
// =============================================================================

import { setupWebSocket as setupKitWebSocket, type WsHandle } from 'agent-common';
import type { Server } from 'http';
import { WebSocket } from 'ws';
import type { AppContext } from '../context.js';
import type { EventType } from '../types.js';
import { readPackageMeta } from '../package-meta.js';

const packageMeta = readPackageMeta();

export type WebSocketHandle = WsHandle;

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
  const subscribedByClient = new WeakMap<WebSocket, Set<EventType | '*'>>();

  return setupKitWebSocket({
    httpServer,
    getFingerprints: () => {
      const row = ctx.db.queryOne<{ fp: string }>(
        `SELECT
           (SELECT COALESCE(
              group_concat(id || ':' || COALESCE(updated_at, ''), '|'), ''
            ) FROM (SELECT id, updated_at FROM tasks ORDER BY id))
           || '|' ||
           (SELECT COALESCE(
              group_concat(id || ':' || task_id || ':' || COALESCE(created_at, ''), '|'), ''
            ) FROM (SELECT id, task_id, created_at FROM task_comments ORDER BY id))
           || '|' ||
           (SELECT COALESCE(
              group_concat(id || ':' || task_id || ':' || COALESCE(created_at, ''), '|'), ''
            ) FROM (SELECT id, task_id, created_at FROM task_artifacts ORDER BY id))
          AS fp`,
      );
      return { pipeline: row?.fp ?? '' };
    },
    getCategoryData: () => buildStatePayload(ctx),
    getFullState: () => ({ version: packageMeta.version, ...buildStatePayload(ctx) }),
    onMessage: (ws, msg) => {
      if (msg.type !== 'subscribe') return false;
      const events = msg.events;
      if (!Array.isArray(events)) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: '"events" must be an array of event type strings',
          }),
        );
        return true;
      }
      const subs = new Set<EventType | '*'>();
      for (const e of events) {
        if (typeof e === 'string' && VALID_EVENT_TYPES.has(e)) {
          subs.add(e as EventType | '*');
        }
      }
      subscribedByClient.set(ws, subs);
      ws.send(JSON.stringify({ type: 'subscribed', events: [...subs] }));
      return true;
    },
    logError: (err) =>
      process.stderr.write(
        '[agent-tasks] WS error: ' + (err instanceof Error ? err.message : String(err)) + '\n',
      ),
  });
}

function buildStatePayload(ctx: AppContext): Record<string, unknown> {
  return {
    tasks: ctx.tasks.list(),
    dependencies: ctx.tasks.getAllDependencies(),
    artifactCounts: ctx.tasks.getArtifactCounts(),
    commentCounts: ctx.comments.countByTask(),
    lastActivityAt: ctx.tasks.getLastActivityByTask(),
    subtaskProgress: ctx.tasks.getAllSubtaskProgress(),
    stages: ctx.tasks.getPipelineStages(),
    gateConfigs: ctx.tasks.getAllGateConfigs(),
    collaborators: ctx.collaborators.listAllByTask(),
  };
}
