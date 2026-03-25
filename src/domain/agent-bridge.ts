// =============================================================================
// agent-tasks — Agent-comm bridge
//
// Listens to task events and forwards notifications to agents via
// agent-comm's REST API. Lightweight runtime integration — no npm dependency.
// =============================================================================

import http from 'http';
import type { EventBus } from './events.js';

const AGENT_COMM_URL = process.env.AGENT_COMM_URL || 'http://localhost:3421';

export class AgentBridge {
  private unsubs: (() => void)[] = [];

  constructor(private readonly events: EventBus) {}

  start(): void {
    this.unsubs.push(
      this.events.on('task:claimed', (e) => {
        const task = e.data.task as { id: number; title: string; assigned_to?: string };
        if (task.assigned_to) {
          this.notify(
            `Task #${task.id} "${task.title}" has been assigned to you.`,
            task.assigned_to,
          );
        }
      }),
    );

    this.unsubs.push(
      this.events.on('task:advanced', (e) => {
        const task = e.data.task as { id: number; title: string; assigned_to?: string };
        const toStage = e.data.to_stage as string;
        if (task.assigned_to) {
          this.notify(`Task #${task.id} "${task.title}" advanced to ${toStage}.`, task.assigned_to);
        }
      }),
    );

    this.unsubs.push(
      this.events.on('comment:created', (e) => {
        const comment = e.data.comment as { task_id: number; agent_id: string; content: string };
        this.notifyChannel(
          `Comment on task #${comment.task_id} by ${comment.agent_id}: ${comment.content.slice(0, 100)}`,
        );
      }),
    );

    this.unsubs.push(
      this.events.on('approval:requested', (e) => {
        const approval = e.data.approval as {
          task_id: number;
          stage: string;
          reviewer?: string;
        };
        if (approval.reviewer) {
          this.notify(
            `Approval requested for task #${approval.task_id} at stage ${approval.stage}.`,
            approval.reviewer,
          );
        }
      }),
    );
  }

  stop(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  fetchAgents(): Promise<unknown[]> {
    return new Promise((resolve) => {
      const url = new URL('/api/agents', AGENT_COMM_URL);
      http
        .get(url, { timeout: 3000 }, (res) => {
          let body = '';
          res.on('data', (c: string) => (body += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve([]);
            }
          });
        })
        .on('error', () => resolve([]))
        .on('timeout', function (this: http.ClientRequest) {
          this.destroy();
          resolve([]);
        });
    });
  }

  private notify(content: string, agentName: string): void {
    this.postMessage({ to: agentName, content }).catch(() => {});
  }

  private notifyChannel(content: string): void {
    this.postMessage({ channel: 'general', content }).catch(() => {});
  }

  private postMessage(payload: Record<string, string>): Promise<void> {
    return new Promise((resolve) => {
      const data = JSON.stringify({ ...payload, from: 'agent-tasks' });
      const url = new URL('/api/messages', AGENT_COMM_URL);

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
          timeout: 3000,
        },
        () => resolve(),
      );

      req.on('error', () => resolve());
      req.on('timeout', () => {
        req.destroy();
        resolve();
      });
      req.write(data);
      req.end();
    });
  }
}
