// =============================================================================
// Claim holders: a claimed task lives as long as the session that claimed it
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { AppContext } from '../src/context.js';
import { HolderService } from '../src/domain/holders.js';
import { createToolHandler } from '../src/transport/mcp.js';
import { startRestServer } from '../src/server.js';
import { createTestContext } from './helpers.js';

let ctx: AppContext;

beforeEach(() => {
  ctx = createTestContext();
});
afterEach(() => {
  vi.useRealTimers();
  ctx.close();
});

const GRACE = 10;

/** Sets the holder's clock back, as if `minutes` had passed since it last beat or ended. */
function age(holder: string, minutes: number) {
  ctx.db.run(
    `UPDATE holders SET seen_at = datetime(seen_at, ?), ended_at = datetime(ended_at, ?) WHERE id = ?`,
    [`-${minutes} minutes`, `-${minutes} minutes`, holder],
  );
}

function claimHeld(holder: string, title = 'work') {
  const task = ctx.tasks.create({ title }, 'lead');
  ctx.holders.beat(holder);
  return ctx.tasks.claim(task.id, 'some-agent', true, holder);
}

const statusOf = (id: number) => ctx.tasks.getById(id)!.status;

describe('liveness comes from the holding session, not from activity', () => {
  // The #2577 case: the session waits in a dialog for half an hour, its agent never
  // speaks, agent-comm calls it offline; its process still beats, so nothing fails.
  it('keeps the task of an idle session that still beats, however long the task sat', () => {
    const task = claimHeld('mcp:idle');
    ctx.db.run(`UPDATE tasks SET updated_at = datetime('now', '-3 hours') WHERE id = ?`, [task.id]);
    ctx.holders.beat('mcp:idle');
    expect(ctx.holders.sweep()).toEqual([]);
    expect(statusOf(task.id)).toBe('in_progress');
  });

  it('fails the task once its session ended longer than the grace ago', () => {
    const task = claimHeld('mcp:done');
    ctx.holders.end('mcp:done');
    expect(ctx.holders.sweep()).toEqual([]);
    age('mcp:done', GRACE + 1);
    const failed = ctx.holders.sweep();
    expect(failed.map((t) => t.id)).toEqual([task.id]);
    expect(ctx.tasks.getById(task.id)).toMatchObject({
      status: 'failed',
      result: 'The session holding this task ended without completing it (some-agent).',
    });
  });

  it('fails the task of a session that stopped beating (a crash) after the grace', () => {
    const task = claimHeld('mcp:crashed');
    age('mcp:crashed', GRACE - 1);
    expect(ctx.holders.sweep()).toEqual([]);
    age('mcp:crashed', 2);
    expect(ctx.holders.sweep().map((t) => t.id)).toEqual([task.id]);
    expect(ctx.tasks.getById(task.id)!.result).toBe(
      'The session holding this task stopped answering (some-agent).',
    );
  });

  it('revives an ended session that beats again within the grace (a resume)', () => {
    const task = claimHeld('claude:s1');
    ctx.holders.end('claude:s1');
    age('claude:s1', GRACE - 2);
    ctx.holders.beat('claude:s1');
    age('claude:s1', 3);
    expect(ctx.holders.sweep()).toEqual([]);
    expect(statusOf(task.id)).toBe('in_progress');
  });

  it('never fails a task nothing holds, whoever it is assigned to', () => {
    const task = ctx.tasks.create({ title: 'old claim' }, 'lead');
    ctx.tasks.claim(task.id, 'system');
    ctx.db.run(`UPDATE tasks SET updated_at = datetime('now', '-30 days') WHERE id = ?`, [task.id]);
    expect(ctx.holders.sweep()).toEqual([]);
    expect(statusOf(task.id)).toBe('in_progress');
  });

  it('emits task:failed for each task it fails', () => {
    const seen: number[] = [];
    ctx.events.on('task:failed', (e) => seen.push((e.data.task as { id: number }).id));
    const task = claimHeld('mcp:gone');
    ctx.holders.end('mcp:gone');
    age('mcp:gone', GRACE + 1);
    ctx.holders.sweep();
    expect(seen).toEqual([task.id]);
  });

  it('forgets a gone holder once it holds nothing open, keeps a live one', () => {
    claimHeld('mcp:gone');
    ctx.holders.beat('mcp:live');
    ctx.holders.end('mcp:gone');
    age('mcp:gone', GRACE + 1);
    ctx.holders.sweep();
    const ids = ctx.db.queryAll<{ id: string }>(`SELECT id FROM holders ORDER BY id`);
    expect(ids.map((r) => r.id)).toEqual(['mcp:live']);
  });
});

describe('who holds a claim', () => {
  it('a claim through the MCP tools is held by that MCP process', async () => {
    const handle = createToolHandler(ctx, 'mcp:proc-1');
    const task = ctx.tasks.create({ title: 'via mcp' }, 'lead');
    await handle('task_stage', { action: 'claim', task_id: task.id, claimer: 'agent-x' });
    expect(ctx.tasks.getById(task.id)!.holder).toBe('mcp:proc-1');
    await handle('task_stage', { action: 'complete', task_id: task.id, result: 'ok' });
    expect(ctx.holders.held('mcp:proc-1')).toEqual([]);
  });

  it('adopting moves a claim to the host session, so a reconnected MCP process loses nothing', () => {
    const task = claimHeld('mcp:old-process');
    expect(ctx.holders.adopt('claude:session', [task.id, 99999])).toEqual([task.id]);
    ctx.holders.end('mcp:old-process');
    age('mcp:old-process', GRACE + 1);
    expect(ctx.holders.sweep()).toEqual([]);
    expect(ctx.holders.held('claude:session').map((t) => t.id)).toEqual([task.id]);
  });

  it('does not adopt a closed task', () => {
    const task = claimHeld('mcp:p');
    ctx.tasks.complete(task.id, 'done');
    expect(ctx.holders.adopt('claude:s', [task.id])).toEqual([]);
  });

  it('a task handed to someone else no longer lives with the claiming session', () => {
    const task = claimHeld('mcp:p');
    ctx.tasks.update(task.id, { assigned_to: 'other-agent' });
    expect(ctx.tasks.getById(task.id)!.holder).toBeNull();
    ctx.tasks.update(task.id, { assigned_to: 'other-agent', title: 'renamed' });
    expect(ctx.tasks.getById(task.id)!.holder).toBeNull();
  });

  it('a task kept by its assignee stays held when other fields change', () => {
    const task = claimHeld('mcp:p');
    ctx.tasks.update(task.id, { assigned_to: 'some-agent', title: 'renamed' });
    expect(ctx.tasks.getById(task.id)!.holder).toBe('mcp:p');
  });

  it('refuses an empty or oversized holder', () => {
    expect(() => ctx.holders.beat('')).toThrow('holder');
    expect(() => ctx.holders.beat('x'.repeat(201))).toThrow('holder');
  });
});

describe('keep(): a process holds while it runs', () => {
  it('beats at once, sweeps only from its second on-time tick, and ends when stopped', () => {
    vi.useFakeTimers();
    const holders = new HolderService(ctx.db, ctx.events, GRACE);
    const sweep = vi.spyOn(holders, 'sweep');
    const stop = holders.keep('mcp:me', 1000);
    expect(ctx.db.queryOne(`SELECT id FROM holders WHERE id = 'mcp:me'`)).toBeTruthy();
    expect(sweep).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(sweep).toHaveBeenCalledTimes(1);
    stop();
    const row = ctx.db.queryOne<{ ended_at: string | null }>(
      `SELECT ended_at FROM holders WHERE id = 'mcp:me'`,
    );
    expect(row?.ended_at).toBeTruthy();
  });

  // After a sleep every holder is silent at once: the first tick after waking beats
  // and leaves judging to the next, by when the other sessions have beaten too.
  it('a tick that comes late (the machine slept) beats without sweeping', () => {
    vi.useFakeTimers();
    const holders = new HolderService(ctx.db, ctx.events, GRACE);
    const sweep = vi.spyOn(holders, 'sweep');
    const stop = holders.keep('mcp:me', 1000);
    vi.advanceTimersByTime(1000);
    expect(sweep).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    vi.advanceTimersByTime(1000);
    expect(sweep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('REST: a host session as holder', () => {
  it('POST beats, adopts and answers what it holds; DELETE ends it', async () => {
    const server = await startRestServer(ctx, 0);
    const base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
    try {
      const task = claimHeld('mcp:p');
      const post = (body: unknown) =>
        fetch(`${base}/api/holders/claude%3As1`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then((r) => r.json());
      expect(await post({})).toEqual({ adopted: [], held: [] });
      const r = (await post({ adopt: [task.id] })) as { adopted: number[]; held: { id: number }[] };
      expect(r.adopted).toEqual([task.id]);
      expect(r.held.map((t) => t.id)).toEqual([task.id]);
      const del = await fetch(`${base}/api/holders/claude%3As1`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      age('claude:s1', GRACE + 1);
      expect(ctx.holders.sweep().map((t) => t.id)).toEqual([task.id]);
    } finally {
      server.close();
    }
  });
});

describe('what a holder holds', () => {
  it('a task sent back to the queue is no one’s work: not held, never failed for its session', () => {
    const task = claimHeld('mcp:p');
    ctx.tasks.regress(task.id, 'backlog', 'lead');
    expect(ctx.tasks.getById(task.id)!.status).toBe('pending');
    expect(ctx.holders.held('mcp:p')).toEqual([]);
    ctx.holders.end('mcp:p');
    age('mcp:p', GRACE + 1);
    expect(ctx.holders.sweep()).toEqual([]);
    expect(ctx.tasks.getById(task.id)!.status).toBe('pending');
  });

  it('a finished task is not sent back: it is reopened', () => {
    const task = claimHeld('mcp:p');
    ctx.tasks.complete(task.id, 'done');
    expect(() => ctx.tasks.regress(task.id, 'spec', 'lead')).toThrow(
      `Task ${task.id} is completed: open it again with task_stage action "reopen".`,
    );
  });

  it('the session that moves a task on holds it from then on', async () => {
    const task = claimHeld('mcp:assigner');
    const other = createToolHandler(ctx, 'mcp:worker');
    await other('task_stage', { action: 'advance', task_id: task.id });
    expect(ctx.tasks.getById(task.id)!.holder).toBe('mcp:worker');
  });

  it('a process named again by its agent takes back that agent’s work nothing alive holds', async () => {
    const mine = claimHeld('mcp:before-restart');
    const live = ctx.tasks.create({ title: 'held by a live one' }, 'lead');
    ctx.holders.beat('mcp:alive');
    ctx.tasks.claim(live.id, 'some-agent', true, 'mcp:alive');
    ctx.holders.end('mcp:before-restart');
    age('mcp:before-restart', GRACE + 1);
    const restarted = createToolHandler(ctx, 'mcp:after-restart');
    const r = (await restarted('task_config', {
      action: 'session',
      id: 's',
      name: 'some-agent',
    })) as { reclaimed?: number[] };
    expect(r.reclaimed).toEqual([mine.id]);
    expect(ctx.tasks.getById(mine.id)!.holder).toBe('mcp:after-restart');
    expect(ctx.tasks.getById(live.id)!.holder).toBe('mcp:alive');
    expect(ctx.holders.sweep()).toEqual([]);
  });
});

describe('REST: what the routes take', () => {
  it('a holder is decoded once; a claim over REST is held by nothing, a stray holder field ignored', async () => {
    const server = await startRestServer(ctx, 0);
    const base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
    try {
      const post = (path: string, body: unknown) =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect((await post('/api/holders/a%2525b', {})).status).toBe(200);
      expect(ctx.db.queryOne(`SELECT id FROM holders WHERE id = 'a%25b'`)).toBeTruthy();
      const made = await post('/api/tasks', { title: 'over REST', holder: 5 });
      expect(made.status).toBe(201);
      const { id } = (await made.json()) as { id: number };
      expect((await post(`/api/tasks/${id}/stage`, { action: 'claim', claimer: 'a' })).status).toBe(
        200,
      );
      expect(ctx.tasks.getById(id)!.holder).toBeNull();
    } finally {
      server.close();
    }
  });
});
