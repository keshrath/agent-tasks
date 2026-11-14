// =============================================================================
// Keys pressed faster than the pane redraws, in the real Claude Code CLI: Enter
// twice on a row opens it and does nothing else, whatever the new view draws at
// the ring's place; a second press comes too soon to act. Sent back with Enter
// keys, a task asks for its stage first; a tab hotkey pressed twice fast types
// nothing into the prompt.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeTerm, startWorld, type World } from './harness.js';

const E2E = process.env.AGENT_TASKS_E2E_CLAUDE === '1';
const MIN = 60_000;
const FULLSCREEN = { CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1' };
const GAPS = [10, 20, 30, 40, 50, 80];

/** Every task's stage, status and result, and whether a form or a delete box is open. */
async function state(w: World) {
  const b = await w.api<{
    open: { id: number; stage: string; status: string }[];
    recent: { id: number; stage: string; status: string; result: string | null }[];
  }>('GET', '/api/board?recent=50');
  return JSON.stringify([
    b.open.map((t) => [t.id, t.stage, t.status]).sort(),
    b.recent.map((t) => [t.id, t.stage, t.status, t.result]).sort(),
  ]);
}

/** Two keys `gap` ms apart, as one hurried double press. */
async function twice(t: ClaudeTerm, key: string, gap: number) {
  await t.type(key, gap);
  await t.type(key, 1_500);
}

/** The ring is not in a field, and no form or delete box asks for anything. */
function nothingAsked(t: ClaudeTerm) {
  const s = t.text();
  expect(s).not.toMatch(
    /There is no undo|Complete #\d+|Mark #\d+ failed|Cancel #\d+|Send #\d+ back/,
  );
}

describe.skipIf(!E2E).each([
  ['docked', 160, 50, FULLSCREEN],
  ['inline', 120, 50, {}],
] as const)('Enter twice on a row, %s', (_name, cols, rows, env) => {
  let w: World;
  let t: ClaudeTerm;
  beforeAll(async () => {
    w = await startWorld();
    t = new ClaudeTerm(w, cols, rows, env);
    await t.start();
  }, 2 * MIN);
  afterAll(async () => {
    await t?.kill();
    await w?.stop();
  }, 2 * MIN);

  // Each row sits at its own place in the focus order: the task view draws Advance, Complete,
  // Send back, Fail, Cancel, Delete (or Reopen, from Done) at one of them.
  const ROWS = [0, 1, 2, 3, 4];
  const board = GAPS.flatMap((gap) => ROWS.map((row) => [gap, row] as const));
  it.each(board)(
    'on the board, %i ms apart, row %i: the task opens, nothing changes',
    async (gap, row) => {
      await t.key('ESC');
      await t.pipeline();
      await t.waitFor(/Backlog \d+/);
      await t.settle();
      for (let i = 0; i < row; i++) await t.key('TAB');
      await t.settle(300, 1_500);
      const before = await state(w);
      await twice(t, '\r', gap);
      await t.settle();
      expect(await state(w)).toBe(before);
      nothingAsked(t);
    },
  );

  // Not waited for: the keys come while the board still lands and draws.
  it.each(GAPS)(
    'right after /pipeline, %i ms apart: whatever opens, nothing changes',
    async (gap) => {
      await t.key('ESC');
      await t.pipeline();
      const before = await state(w);
      await twice(t, '\r', gap);
      await t.settle();
      expect(await state(w)).toBe(before);
      nothingAsked(t);
    },
  );

  // A task opened, then back and in again at once: the way back and the row share places.
  it.each(GAPS)('Back then Enter, %i ms apart: nothing changes', async (gap) => {
    await t.key('ESC');
    await t.pipeline();
    await t.waitFor(/Backlog \d+/);
    await t.settle();
    await t.key('TAB');
    await t.key('TAB');
    await t.settle(300, 1_500);
    const before = await state(w);
    for (let i = 0; i < 3; i++) await twice(t, '\r', gap);
    expect(await state(w)).toBe(before);
    nothingAsked(t);
  });

  const done = [20, 40, 80].flatMap((gap) => [1, 2, 3].map((row) => [gap, row] as const));
  it.each(done)(
    'on Done, %i ms apart, row %i: the task opens, nothing changes',
    async (gap, row) => {
      await t.key('ESC');
      await t.pipeline();
      await t.waitFor(/Backlog \d+/);
      await t.key('2');
      await t.waitFor(/Recently finished/);
      await t.settle();
      for (let i = 1; i < row; i++) await t.key('TAB');
      await t.settle(300, 1_500);
      const before = await state(w);
      await twice(t, '\r', gap);
      await t.settle();
      expect(await state(w)).toBe(before);
      nothingAsked(t);
    },
  );
});

describe.skipIf(!E2E)('hurried keys in a task and on the tabs', { timeout: MIN }, () => {
  let w: World;
  let t: ClaudeTerm;
  beforeAll(async () => {
    w = await startWorld();
    t = new ClaudeTerm(w, 160, 50, FULLSCREEN);
    await t.start();
  }, 2 * MIN);
  afterAll(async () => {
    await t?.kill();
    await w?.stop();
  }, 2 * MIN);

  const working = (title: string) =>
    w.domain((c) => {
      const { id } = c.tasks.create({ title, project: 'keys' }, 'lead');
      c.tasks.claim(id, 'agent-k');
      c.tasks.advance(id);
      return id;
    });

  it.each([80, 150])(
    'Send back, then Enter twice %i ms apart: it asks for the stage, sends nothing',
    async (gap) => {
      const id = await working(`Sent back in a hurry ${gap}`);
      await t.key('ESC');
      await t.pipeline(String(id));
      await t.waitFor(new RegExp(`Sent back in a hurry ${gap}`));
      await t.focus('‹ Send back');
      await t.settle();
      await twice(t, '\r', gap);
      await t.type('\r', 1_500);
      expect((await w.task(id)).stage).toBe('plan');
      await t.press('Never mind');
    },
  );

  it('Advance drawn before a move elsewhere is refused, never a skip', async () => {
    const id = await working('Moved back under the button');
    await t.key('ESC');
    await t.pipeline(String(id));
    await t.waitFor(/Advance › implement/);
    await t.focus('Advance › implement');
    await t.settle(500, 3_000);
    await w.api('POST', `/api/tasks/${id}/stage`, {
      action: 'regress',
      stage: 'spec',
      by: 'agent-k',
    });
    await t.key('ENTER');
    await t.waitFor(new RegExp(`#${id} moved elsewhere|Advance › plan`), 15_000);
    await t.settle();
    expect((await w.task(id)).stage).not.toBe('implement');
  });

  it('Advance pressed three times fast moves it once and says nothing of task_stage', async () => {
    const id = await working('Pressed thrice');
    await t.key('ESC');
    await t.pipeline(String(id));
    await t.waitFor(/Advance › implement/);
    await t.focus('Advance › implement');
    await t.settle(500, 3_000);
    await t.type('\r', 40);
    await t.type('\r', 40);
    await t.type('\r', 2_000);
    expect((await w.task(id)).stage).toBe('implement');
    expect(t.text()).not.toMatch(/task_stage|not ahead/);
  });

  it('3 twice 40 ms apart puts the ring in Title: what is typed next is the title', async () => {
    await t.key('ESC');
    await t.pipeline();
    await t.waitFor(/Backlog \d+/);
    await t.settle();
    await t.type('3', 40);
    await t.type('3', 600);
    await t.type('Hurried title', 400);
    const s = await t.waitFor(/Title\s+Hurried title/);
    // Nothing reached the prompt, left of the pane.
    expect(
      s
        .split('\n')
        .map((l) => l.split('│')[0])
        .join('\n'),
    ).not.toMatch(/Hurried title/);
    await t.key('TAB');
    await t.press('Clear');
  });
});
