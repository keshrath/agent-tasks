// =============================================================================
// The dashboard's and widget's data rules (src/ui/lib/model.js) over real
// server answers: the board snapshot, find and pickers, columns, the actions a
// task offers (the pane's rules), the gate in words, and the charts' counts.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';
import type { AppContext } from '../src/context.js';
import { startRestServer, type RestServer } from '../src/server.js';
import { createTestContext } from './helpers.js';
import {
  actionsFor,
  columns,
  detail,
  gateHint,
  matches,
  snapshot,
  snapshotOf,
  throughput,
  // @ts-expect-error -- plain browser ESM without type declarations
} from '../src/ui/lib/model.js';

let ctx: AppContext;
let server: RestServer;
let base: string;

beforeEach(async () => {
  ctx = createTestContext();
  server = await startRestServer(ctx, 0);
  base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});
afterEach(() => {
  server.close();
  ctx.close();
});

const get = async (path: string) => (await fetch(`${base}${path}`)).json();
const none = { find: '', project: '', assignee: '' };

function board() {
  const t = ctx.tasks;
  const a = t.create({ title: 'Alpha', project: 'api', tags: ['backend'], priority: 2 }, 'me').id;
  const b = t.create({ title: 'Beta', project: 'web' }, 'me').id;
  t.claim(a, 'alice');
  t.claim(b, 'bob');
  t.addDependency(b, a, 'blocks');
  const c = t.create({ title: 'Gamma' }, 'me').id;
  const d = t.create({ title: 'Delta', project: 'api' }, 'me').id;
  t.claim(d, 'alice');
  t.complete(d, 'done');
  return { a, b, c, d };
}

describe('snapshot', () => {
  it('reads GET /api/board: open with blockers, recent closed, tags parsed', async () => {
    const { a, b, c, d } = board();
    const snap = snapshot(await get('/api/board'));
    expect(snap.stages[0]).toBe('backlog');
    expect(snap.open.map((t: { id: number }) => t.id).sort()).toEqual([a, b, c]);
    expect(snap.recent.map((t: { id: number }) => t.id)).toEqual([d]);
    const beta = snap.open.find((t: { id: number }) => t.id === b);
    expect(beta.blocked_by).toEqual([a]);
    expect(snap.open.find((t: { id: number }) => t.id === a).tags).toEqual(['backend']);
  });

  it('reads a plain task list (the widget) without blockers', () => {
    const snap = snapshotOf([
      { id: 1, title: 'x', status: 'pending', stage: 'backlog', tags: '["a"]' },
      { id: 2, title: 'y', status: 'failed', stage: 'test', updated_at: '2026-01-01 00:00:00' },
    ]);
    expect(snap.open).toHaveLength(1);
    expect(snap.recent[0].status).toBe('failed');
    expect(snap.open[0].tags).toEqual(['a']);
  });
});

describe('find and columns', () => {
  it('#N finds that task only; text is found in title, agent, project, tags', async () => {
    const snap = snapshot(await get('/api/board'));
    const t = {
      id: 12,
      title: 'Fix 3.12 regression',
      assigned_to: 'alice',
      project: 'api',
      tags: ['ux'],
      blocked_by: [],
    };
    expect(matches(t, '#12')).toBe(true);
    expect(matches({ ...t, id: 3 }, '#12')).toBe(false);
    for (const q of ['3.12', 'ALICE', 'api', 'ux', '']) expect(matches(t, q), q).toBe(true);
    expect(matches(t, 'bob')).toBe(false);
    expect(snap.open).toEqual([]);
  });

  it('a column per stage, working first, pickers applied; done only when used', async () => {
    const { a, b, c } = board();
    const snap = snapshot(await get('/api/board'));
    const cols = columns(snap, none);
    expect(cols.map((x: { stage: string }) => x.stage)).toEqual([
      'backlog',
      'spec',
      'plan',
      'implement',
      'test',
      'review',
    ]);
    expect(cols[0].tasks.map((t: { id: number }) => t.id)).toEqual([c]);
    expect(cols[1].tasks.map((t: { id: number }) => t.id)).toEqual([a, b]);
    const api = columns(snap, { ...none, project: 'api' }).flatMap(
      (x: { tasks: unknown[] }) => x.tasks,
    );
    expect(api).toHaveLength(1);
    const nobody = columns(snap, { ...none, assignee: 'unclaimed' }).flatMap(
      (x: { tasks: unknown[] }) => x.tasks,
    );
    expect(nobody.map((t) => (t as { id: number }).id)).toEqual([c]);
  });
});

describe('actions a task offers', () => {
  async function detailOf(id: number) {
    const t = await get(`/api/tasks/${id}?include=subtasks,comments`);
    const p = await get('/api/pipeline');
    return detail(t, p.stages, snapshot(await get('/api/board')));
  }

  it('in progress and free: Advance to the next stage is the primary step', async () => {
    const { a } = board();
    const acts = actionsFor(await detailOf(a));
    expect(acts).toMatchObject({
      advance: 'plan',
      complete: true,
      primary: 'advance',
      fail: true,
      cancel: true,
      reopen: false,
    });
    expect(acts.regress).toEqual(['backlog']);
  });

  it('blocked: no Advance or Complete, only what it waits for', async () => {
    const { a, b } = board();
    const acts = actionsFor(await detailOf(b));
    expect(acts).toMatchObject({ advance: null, complete: false, primary: null });
    expect(acts.waiting.map((x: { id: number }) => x.id)).toEqual([a]);
  });

  it('unclaimed: no Advance or Complete; finished: Reopen', async () => {
    const { c, d } = board();
    expect(actionsFor(await detailOf(c))).toMatchObject({
      advance: null,
      complete: false,
      fail: false,
      cancel: true,
    });
    expect(actionsFor(await detailOf(d))).toMatchObject({
      reopen: true,
      cancel: false,
      regress: [],
    });
  });

  it('a gate an agent must pass hides Advance and Complete and says who gives it', async () => {
    const { a } = board();
    ctx.tasks.setGateConfig('api', { require_comment: true, require_artifact: true });
    const d = await detailOf(a);
    expect(actionsFor(d)).toMatchObject({ advance: null, complete: false });
    expect(gateHint(d.gate, d.stage)).toBe(
      'Needs a comment and an artifact before it leaves spec: add a comment below; an agent attaches artifacts.',
    );
  });
});

describe('throughput', () => {
  it('counts finished tasks per local day, completed apart from the rest', () => {
    const now = new Date('2026-11-27T12:00:00');
    const at = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
    const days = throughput(
      [
        { status: 'completed', updated_at: at(now) },
        { status: 'failed', updated_at: at(now) },
        { status: 'completed', updated_at: at(new Date(now.getTime() - 86_400_000)) },
        { status: 'completed', updated_at: at(new Date(now.getTime() - 9 * 86_400_000)) },
      ],
      7,
      now,
    );
    expect(days).toHaveLength(7);
    expect(days[6]).toMatchObject({ done: 1, failed: 1 });
    expect(days[5]).toMatchObject({ done: 1, failed: 0 });
    expect(days.reduce((n: number, x: { done: number }) => n + x.done, 0)).toBe(2);
  });
});
