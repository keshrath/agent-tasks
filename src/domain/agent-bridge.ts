// =============================================================================
// agent-tasks — Agent-comm bridge
//
// Listens to task events and forwards notifications to agents via
// agent-comm's REST API. Lightweight runtime integration — no npm dependency.
// =============================================================================

import http from 'http';
import type { EventBus } from './events.js';

const AGENT_COMM_URL = process.env.AGENT_COMM_URL || 'http://localhost:3421';

interface TaskPayload {
  id: number;
  title: string;
  assigned_to?: string;
}

interface CommentPayload {
  task_id: number;
  agent_id: string;
  content: string;
}

interface ApprovalPayload {
  task_id: number;
  stage: string;
  reviewer?: string;
}

function isTaskPayload(v: unknown): v is TaskPayload {
  return typeof v === 'object' && v !== null && typeof (v as TaskPayload).id === 'number';
}

function isCommentPayload(v: unknown): v is CommentPayload {
  return typeof v === 'object' && v !== null && typeof (v as CommentPayload).task_id === 'number';
}

function isApprovalPayload(v: unknown): v is ApprovalPayload {
  return typeof v === 'object' && v !== null && typeof (v as ApprovalPayload).task_id === 'number';
}

export class AgentBridge {
  private unsubs: (() => void)[] = [];
  private warned = false;

  constructor(private readonly events: EventBus) {}

  start(): void {
    this.unsubs.push(
      this.events.on('task:claimed', (e) => {
        const task = e.data.task;
        if (!isTaskPayload(task)) return;
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
        const task = e.data.task;
        if (!isTaskPayload(task)) return;
        const toStage = String(e.data.to_stage ?? '');
        if (task.assigned_to) {
          this.notify(`Task #${task.id} "${task.title}" advanced to ${toStage}.`, task.assigned_to);
        }
      }),
    );

    this.unsubs.push(
      this.events.on('comment:created', (e) => {
        const comment = e.data.comment;
        if (!isCommentPayload(comment)) return;
        this.notifyChannel(
          `Comment on task #${comment.task_id} by ${comment.agent_id}: ${comment.content.slice(0, 100)}`,
        );
      }),
    );

    this.unsubs.push(
      this.events.on('approval:requested', (e) => {
        const approval = e.data.approval;
        if (!isApprovalPayload(approval)) return;
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
            } catch (err) {
              process.stderr.write(
                '[agent-tasks] fetchAgents JSON parse: ' +
                  (err instanceof Error ? err.message : String(err)) +
                  '\n',
              );
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

      req.on('error', () => {
        if (!this.warned) {
          this.warned = true;
          process.stderr.write(
            `[agent-tasks] agent-comm not reachable at ${AGENT_COMM_URL} — task notifications disabled. ` +
              `Install: https://github.com/keshrath/agent-comm\n`,
          );
        }
        resolve();
      });
      req.on('timeout', () => {
        req.destroy();
        if (!this.warned) {
          this.warned = true;
          process.stderr.write(
            `[agent-tasks] agent-comm timeout at ${AGENT_COMM_URL} — task notifications disabled. ` +
              `Install: https://github.com/keshrath/agent-comm\n`,
          );
        }
        resolve();
      });
      req.write(data);
      req.end();
    });
  }
}
