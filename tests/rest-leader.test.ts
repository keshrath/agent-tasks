// =============================================================================
// REST leader election — the port's next holder takes over when the server exits
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'net';
import type { AppContext } from '../src/context.js';
import { serveRestWhenFree, type RestLeader } from '../src/server.js';
import { createTestContext } from './helpers.js';

const contexts: AppContext[] = [];
const leaders: RestLeader[] = [];

afterEach(() => {
  for (const l of leaders.splice(0)) l.close();
  for (const c of contexts.splice(0)) c.close();
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function lead(port: number): RestLeader {
  const ctx = createTestContext();
  contexts.push(ctx);
  const leader = serveRestWhenFree(ctx, port, 20);
  leaders.push(leader);
  return leader;
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('serveRestWhenFree', () => {
  it('lets one process serve and another take over once it exits', async () => {
    const port = await freePort();
    const first = lead(port);
    await until(() => first.server !== null);
    const second = lead(port);
    await new Promise((r) => setTimeout(r, 100));
    expect(second.server).toBeNull();

    first.close();
    await until(() => second.server !== null);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });

  it('stops retrying once closed', async () => {
    const port = await freePort();
    const first = lead(port);
    await until(() => first.server !== null);
    const second = lead(port);
    second.close();
    first.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(second.server).toBeNull();
  });
});
