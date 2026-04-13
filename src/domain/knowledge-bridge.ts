// =============================================================================
// agent-tasks — Agent-knowledge bridge
//
// Listens to task events and pushes learnings/decisions to agent-knowledge
// via its REST API. Lightweight runtime integration — no npm dependency.
// Mirrors AgentBridge pattern: HTTP-only, fail-open.
// =============================================================================

import http from 'http';
import type { EventBus } from './events.js';
import type { Db } from '../storage/database.js';
import type { Task, TaskArtifact } from '../types.js';

function getKnowledgeUrl(): string {
  return process.env.AGENT_KNOWLEDGE_URL || 'http://localhost:3423';
}

function isTask(v: unknown): v is Task {
  return typeof v === 'object' && v !== null && typeof (v as Task).id === 'number';
}

interface KnowledgeWritePayload {
  category: string;
  filename: string;
  content: string;
}

export class KnowledgeBridge {
  private unsubs: (() => void)[] = [];
  private warned = false;

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  start(): void {
    this.unsubs.push(
      this.events.on('task:completed', (e) => {
        const task = e.data.task;
        if (!isTask(task)) return;
        this.pushTaskKnowledge(task).catch(() => {});
      }),
    );
  }

  stop(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  private async pushTaskKnowledge(task: Task): Promise<void> {
    const artifacts = this.db.queryAll<TaskArtifact>(
      `SELECT * FROM task_artifacts WHERE task_id = ? AND (name = 'learning' OR name = 'decision') ORDER BY created_at ASC`,
      [task.id],
    );

    if (artifacts.length === 0) return;

    let learningIdx = 0;
    let decisionIdx = 0;

    for (const artifact of artifacts) {
      const isLearning = artifact.name === 'learning';
      const idx = isLearning ? ++learningIdx : ++decisionIdx;
      const typeLabel = isLearning ? 'Learning' : 'Decision';

      const filename = `task-${task.id}-${artifact.name}-${idx}.md`;
      const content = this.formatEntry(task, artifact, typeLabel);

      this.postKnowledge({ category: 'decisions', filename, content }).catch(() => {});
    }
  }

  private formatEntry(task: Task, artifact: TaskArtifact, typeLabel: string): string {
    const tags = ['agent-tasks', artifact.name];
    if (task.project) tags.push(task.project);

    const lines = [
      '---',
      `title: "Task #${task.id}: ${task.title.replace(/"/g, '\\"')} — ${typeLabel}"`,
      `tags: [${tags.join(', ')}]`,
      'confidence: extracted',
      'source: agent-tasks',
      '---',
      '',
      '## Context',
      `- **Task**: #${task.id} "${task.title}"`,
    ];

    if (task.project) lines.push(`- **Project**: ${task.project}`);
    if (task.assigned_to) lines.push(`- **Completed by**: ${task.assigned_to}`);
    lines.push(`- **Completed at**: ${task.updated_at}`);
    lines.push(`- **Stage**: ${artifact.stage}`);
    lines.push('');
    lines.push(`## ${typeLabel}`);
    lines.push(artifact.content);

    return lines.join('\n');
  }

  private postKnowledge(payload: KnowledgeWritePayload): Promise<void> {
    return new Promise((resolve) => {
      const data = JSON.stringify(payload);
      const url = new URL('/api/knowledge', getKnowledgeUrl());

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
          timeout: 10000,
        },
        () => resolve(),
      );

      req.on('error', () => {
        if (!this.warned) {
          this.warned = true;
          process.stderr.write(
            `[agent-tasks] agent-knowledge not reachable at ${getKnowledgeUrl()} — learnings will not be persisted. ` +
              `Install: https://github.com/keshrath/agent-knowledge\n`,
          );
        }
        resolve();
      });
      req.on('timeout', () => {
        req.destroy();
        if (!this.warned) {
          this.warned = true;
          process.stderr.write(
            `[agent-tasks] agent-knowledge timeout at ${getKnowledgeUrl()} — learnings will not be persisted. ` +
              `Install: https://github.com/keshrath/agent-knowledge\n`,
          );
        }
        resolve();
      });
      req.write(data);
      req.end();
    });
  }
}
