// =============================================================================
// Request guard + body parsing — what reaches a REST handler and what does not
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request, type IncomingMessage, type ServerResponse } from 'http';
import { createRequestGuard } from '../src/transport/guard.js';
import { startRestServer, type RestServer } from '../src/server.js';
import type { AppContext } from '../src/context.js';
import { createTestContext } from './helpers.js';

interface Answer {
  status: number;
  body: string;
}

function ask(
  guard: ReturnType<typeof createRequestGuard>,
  headers: Record<string, string>,
  method = 'GET',
): Answer | null {
  let answer: Answer | null = null;
  const res = {
    writeHead(status: number) {
      answer = { status, body: '' };
      return res;
    },
    end(body: string) {
      answer!.body = body;
    },
  } as unknown as ServerResponse;
  const req = { method, headers } as unknown as IncomingMessage;
  return guard(req, res) ? answer : null;
}

describe('createRequestGuard', () => {
  const guard = createRequestGuard(3422);

  it('lets loopback hosts on the server port through', () => {
    for (const host of ['localhost:3422', '127.0.0.1:3422', '[::1]:3422', 'LOCALHOST:3422']) {
      expect(ask(guard, { host })).toBeNull();
    }
  });

  it('refuses other hosts, other ports and a missing Host (DNS rebinding)', () => {
    for (const host of ['evil.com:3422', 'localhost:3423', 'localhost', '127.0.0.2:3422']) {
      expect(ask(guard, { host })).toEqual({
        status: 403,
        body: JSON.stringify({ error: 'Forbidden host' }),
      });
    }
    expect(ask(guard, {})?.status).toBe(403);
  });

  it('accepts the bound host when the server binds elsewhere, any host on a wildcard bind', () => {
    const lan = createRequestGuard(3422, '192.168.1.5');
    expect(ask(lan, { host: '192.168.1.5:3422' })).toBeNull();
    expect(ask(lan, { host: 'localhost:3422' })).toBeNull();
    expect(ask(lan, { host: '192.168.1.6:3422' })?.status).toBe(403);
    const v6 = createRequestGuard(3422, 'fe80::1');
    expect(ask(v6, { host: '[fe80::1]:3422' })).toBeNull();
    const wildcard = createRequestGuard(3422, '0.0.0.0');
    expect(ask(wildcard, { host: 'localhost:3422' })).toBeNull();
    expect(ask(wildcard, { host: '0.0.0.0:3422' })?.status).toBe(403);
  });

  it('refuses every Origin, loopback ones included', () => {
    for (const origin of ['http://localhost:3422', 'http://127.0.0.1:5173', 'null', 'file://']) {
      expect(ask(guard, { host: 'localhost:3422', origin })).toEqual({
        status: 403,
        body: JSON.stringify({ error: 'Forbidden origin' }),
      });
    }
  });

  it('wants application/json for a body on a state-changing method', () => {
    const host = 'localhost:3422';
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(
        ask(guard, { host, 'content-length': '2', 'content-type': 'text/plain' }, method)?.status,
      ).toBe(415);
      expect(
        ask(guard, { host, 'transfer-encoding': 'chunked' }, method)?.status,
        `${method} chunked without a type`,
      ).toBe(415);
      expect(
        ask(
          guard,
          { host, 'content-length': '2', 'content-type': 'Application/JSON; charset=utf-8' },
          method,
        ),
      ).toBeNull();
      expect(ask(guard, { host, 'content-length': '0' }, method)).toBeNull();
    }
    expect(ask(guard, { host, 'content-length': '2', 'content-type': 'text/plain' })).toBeNull();
  });
});

describe('REST bodies', () => {
  let ctx: AppContext;
  let server: RestServer;

  beforeEach(async () => {
    ctx = createTestContext();
    server = await startRestServer(ctx, 0);
  });

  afterEach(() => {
    server.close();
    ctx.close();
  });

  async function post(body: string) {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return { status: res.status, body: (await res.json()) as { error?: string; id?: number } };
  }

  it('takes a JSON object', async () => {
    const res = await post(JSON.stringify({ title: 'From REST' }));
    expect(res.status).toBe(201);
    expect(ctx.tasks.getById(res.body.id!)?.title).toBe('From REST');
  });

  it('refuses invalid JSON, a non-object and an oversized body with 422', async () => {
    expect(await post('{nope')).toEqual({
      status: 422,
      body: { error: 'Invalid JSON in request body' },
    });
    expect(await post('[1,2]')).toEqual({
      status: 422,
      body: { error: 'Request body must be a JSON object' },
    });
    const big = await post(JSON.stringify({ title: 'x', description: 'y'.repeat(140_000) }));
    expect(big).toEqual({ status: 422, body: { error: 'Request body too large' } });
    expect(ctx.tasks.count()).toBe(0);
  });

  it('answers through the guard: a foreign Host never reaches a route', async () => {
    // fetch drops a Host header it is given; node:http sends it.
    const status = await new Promise<number>((resolve, reject) => {
      request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/health',
          headers: { Host: `evil.com:${server.port}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      )
        .on('error', reject)
        .end();
    });
    expect(status).toBe(403);
  });
});
