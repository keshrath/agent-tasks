import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { createTestContext } from './helpers.js';
import type { AppContext } from '../src/context.js';

describe('KnowledgeBridge', () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.close();
  });

  it('subscribes to task:completed events on start', () => {
    expect(ctx.events.listenerCount('task:completed')).toBeGreaterThanOrEqual(1);
  });

  it('unsubscribes on stop', () => {
    const before = ctx.events.listenerCount('task:completed');
    ctx.knowledgeBridge.stop();
    expect(ctx.events.listenerCount('task:completed')).toBeLessThan(before);
  });

  it('does not crash when agent-knowledge is unreachable', async () => {
    const task = ctx.tasks.create({ title: 'Test task', assign_to: 'test-agent' }, 'test-agent');
    ctx.tasks.claim(task.id, 'test-agent');
    ctx.tasks.addArtifact(task.id, 'learning', 'Use retry with exponential backoff', 'test-agent');
    ctx.tasks.complete(task.id, 'Done');

    await new Promise((r) => setTimeout(r, 200));
  });

  it('pushes learning artifacts to agent-knowledge on completion', async () => {
    const received: Array<{ category: string; filename: string; content: string }> = [];

    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/knowledge') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          received.push(JSON.parse(body));
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: 'decisions/test.md' }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const origEnv = process.env.AGENT_KNOWLEDGE_URL;
    process.env.AGENT_KNOWLEDGE_URL = `http://localhost:${port}`;

    ctx.close();
    ctx = createTestContext();

    try {
      const task = ctx.tasks.create(
        {
          title: 'Auth refactor',
          assign_to: 'dev-agent',
          project: 'backend',
        },
        'dev-agent',
      );
      ctx.tasks.claim(task.id, 'dev-agent');
      ctx.tasks.addArtifact(task.id, 'learning', 'Always validate tokens server-side', 'dev-agent');
      ctx.tasks.addArtifact(
        task.id,
        'decision',
        'JWT over session cookies for stateless auth',
        'dev-agent',
      );
      ctx.tasks.complete(task.id, 'Auth refactor shipped');

      await new Promise((r) => setTimeout(r, 500));

      expect(received.length).toBeGreaterThanOrEqual(1);

      const learningEntry = received.find((r) => r.filename.includes('learning'));
      expect(learningEntry).toBeDefined();
      expect(learningEntry!.category).toBe('decisions');
      expect(learningEntry!.content).toContain('Always validate tokens server-side');
      expect(learningEntry!.content).toContain('Auth refactor');
      expect(learningEntry!.content).toContain('backend');
      expect(learningEntry!.content).toContain('confidence: extracted');
      expect(learningEntry!.content).toContain('source: agent-tasks');
    } finally {
      process.env.AGENT_KNOWLEDGE_URL = origEnv;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('skips tasks with no learning or decision artifacts', async () => {
    const received: unknown[] = [];

    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          received.push(JSON.parse(body));
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: 'test.md' }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const origEnv = process.env.AGENT_KNOWLEDGE_URL;
    process.env.AGENT_KNOWLEDGE_URL = `http://localhost:${port}`;

    ctx.close();
    ctx = createTestContext();

    try {
      const task = ctx.tasks.create({ title: 'Simple fix' }, 'agent');
      ctx.tasks.claim(task.id, 'agent');
      ctx.tasks.addArtifact(task.id, 'spec-doc', 'Just a regular artifact', 'agent');
      ctx.tasks.complete(task.id, 'Fixed');

      await new Promise((r) => setTimeout(r, 300));

      expect(received).toHaveLength(0);
    } finally {
      process.env.AGENT_KNOWLEDGE_URL = origEnv;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
