// =============================================================================
// The /pipeline pane's board, Done and New in the real Claude Code CLI
// (AGENT_TASKS_E2E_CLAUDE=1, `npm run e2e:claude`), past what pane.e2e.test.ts
// walks: every command form, the keyboard and the mouse on the board, the
// status entry and the context block the model is given, toasts from other
// sessions, a long board with a custom pipeline and long or wide titles, an
// empty board, and the narrow and inline layouts. One test asks the model to
// quote its context block: the only model call of the suite.
// Shots land in ~/.claude/tmp/pane-shots-tasks/e2e/board-*.png.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ClaudeTerm,
  ME,
  SHOTS_DIR,
  landsOn,
  sleep,
  startWorld,
  statusEntry,
  until,
  type Ctx,
  type World,
} from './harness.js';
import { renderShots } from './render.js';

const E2E = process.env.AGENT_TASKS_E2E_CLAUDE === '1';
const MIN = 60_000;
vi.setConfig({ testTimeout: 3 * MIN });

const FULLSCREEN = { CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1' };

const shots: string[] = [];
function shot(t: ClaudeTerm, label: string) {
  shots.push(`board-${label}`);
  return t.shot(`board-${label}`);
}

/**
 * The column the docked pane starts at: right of the border it is drawn behind (the column
 * most lines have a `│` in), the tab bar scrolled away or not.
 */
function paneColumn(t: ClaudeTerm): number {
  const at = new Map<number, number>();
  for (const line of t.text().split('\n')) {
    const x = line.indexOf('│');
    if (x > 0) at.set(x, (at.get(x) ?? 0) + 1);
  }
  const [border] = [...at.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (border === undefined) throw new Error(`no docked pane on the screen:\n${t.screen()}`);
  return border + 1;
}

/** The pane's lines, as drawn right of its border. */
function paneLines(t: ClaudeTerm): string[] {
  const from = paneColumn(t);
  return t
    .text()
    .split('\n')
    .map((l) => l.slice(from).trimEnd());
}

/** Waits until the screen stops matching `re`. */
async function gone(t: ClaudeTerm, re: RegExp, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && re.test(t.text())) await sleep(200);
  if (re.test(t.text())) throw new Error(`still on the screen: ${re}\n${t.screen()}`);
}

const LONG_TITLE =
  'Write the migration guide from the 1.x web dashboard to the /pipeline pane, covering every screen the dashboard had, the REST routes that went away and what replaces them, the agent-desk tab and the WebSocket clients';
/** 39 characters, 78 columns: wide enough to wrap if a row counts characters, not columns. */
const WIDE_TITLE =
  '日本語のドキュメントを翻訳して全ての画面の説明を最新の版に合わせて書き直す作業です 🚀';

/** A long board: 45 more backlog tasks, a project with its own pipeline, long and wide titles. */
const bigBoard = (c: Ctx) => {
  const t = c.tasks;
  const out: Record<string, number> = {};
  for (let i = 1; i <= 45; i++)
    out[`bulk${i}`] = t.create(
      { title: `Bulk task ${String(i).padStart(2, '0')}`, project: 'bulk' },
      'lead',
    ).id;
  t.setPipelineConfig('docs-site', ['todo', 'draft', 'proof', 'published']);
  out.todo = t.create({ title: 'Outline the site', project: 'docs-site' }, 'lead').id;
  out.draft = t.create({ title: 'Draft the install page', project: 'docs-site' }, 'lead').id;
  t.claim(out.draft, 'agent-writer');
  out.proof = t.create({ title: 'Proofread the FAQ', project: 'docs-site' }, 'lead').id;
  t.claim(out.proof, 'agent-editor');
  t.advance(out.proof);
  out.long = t.create({ title: LONG_TITLE, project: 'docs', priority: 9 }, 'lead').id;
  out.wide = t.create({ title: WIDE_TITLE, project: 'i18n', priority: 7 }, 'lead').id;
  return out;
};

describe.skipIf(!E2E)('/pipeline board, Done and New in Claude Code', () => {
  afterAll(async () => {
    if (shots.length) await renderShots(SHOTS_DIR, shots);
  }, 2 * MIN);

  // ---------------------------------------------------------------------------
  // The shared board: commands, keys, the mouse, status and context, toasts
  // ---------------------------------------------------------------------------

  describe('the shared board, docked (fullscreen, 160 columns)', () => {
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

    it('the model is given what is in flight, highest priority first', async () => {
      // The context block rides on the conversation's first message: ask the model to quote it.
      await t.type(
        'Quote, verbatim and complete, the one context block of yours that starts with "agent-tasks pipeline". Reply with that text only, no tools.',
      );
      await sleep(300);
      await t.key('ENTER');
      const s = await t.waitFor(/agent-tasks pipeline \(shared by every session\)/, 3 * MIN);
      const quoted = s.slice(s.lastIndexOf('agent-tasks pipeline (shared')).replace(/\s+/g, ' ');
      expect(quoted).toMatch(/6 in progress/);
      expect(quoted).toContain(
        `#${w.ids.pane} "Replace the web dashboard with a Claude Code pane"`,
      );
      expect(quoted).toMatch(/\[implement, agent-pane\]/);
      // Pending: the highest priority first (the ship task is p2, the rest p0).
      expect(quoted).toMatch(/6 pending, highest priority first: #\d+ "Ship muk_import/);
      expect(quoted).toMatch(/Claim a task \(task_stage\) before working on it/);
      await t.waitFor(/❯\s*$/m, MIN);
    });

    it('/pipeline answers with the board summary and opens the pane', async () => {
      await t.pipeline();
      const s = await t.waitFor(/Backlog \d+/);
      expect(s).toMatch(
        /⎿\s+agent-tasks: 12 open tasks · 6 in progress · 1 blocked|⎿\s+12 open tasks · 6 in progress · 1 blocked/,
      );
      // The stage counts, in pipeline order, under the summary.
      expect(s).toMatch(/backlog 6 · spec 2 · implement 2 · review 2/);
      // In each stage, work in progress first, then by priority, then oldest first.
      const backlog = s.slice(s.indexOf('Backlog 6'), s.indexOf('Spec 2'));
      const order = [w.ids.ship, w.ids.detailView, w.ids.flaky, w.ids.badges].map((id) =>
        backlog.indexOf(`#${id} `),
      );
      expect(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]!))).toBe(true);
      shot(t, 'shared');
    });

    it('priority marks: p5 and up stand out, lower ones are dim, none for p0', async () => {
      const high = t.style('p8', paneColumn(t));
      const low = t.style('p2', paneColumn(t));
      const plain = t.style('Ship muk_import', paneColumn(t));
      expect(high.fg).not.toBe(-1); // a theme colour, not the default
      // Dim: drawn apart from both the warning colour and the title's text.
      expect(low.dim || low.fg !== plain.fg).toBe(true);
      expect(low.fg).not.toBe(high.fg);
      // A p0 task draws no mark at all.
      const flakyRow = t
        .text()
        .split('\n')
        .find((l) => l.includes(`#${w.ids.flaky} Investigate`))!;
      expect(flakyRow).not.toMatch(/\bp0\b/);
    });

    it('Tab and shift+Tab walk the rows; above the first row is Find', async () => {
      await landsOn(t, `#${w.ids.ship} Ship`);
      await t.key('TAB');
      await landsOn(t, `#${w.ids.detailView} Pane: detail view`);
      await t.key('TAB');
      await landsOn(t, `#${w.ids.flaky} Investigate`);
      await t.key('SHIFTTAB', 2);
      await landsOn(t, `#${w.ids.ship} Ship`);
      await t.key('SHIFTTAB');
      await landsOn(t, 'Find');
      // In the field the hotkeys type: the header says how out.
      await t.waitFor(/Tab leaves the field · Esc to the prompt/);
      await t.key('TAB');
      await landsOn(t, `#${w.ids.ship} Ship`);
      await t.waitFor(/Tab moves · Enter presses/);
    });

    it('Esc gives the keyboard to the prompt; ctrl+x tab takes it back', async () => {
      await t.key('TAB');
      await landsOn(t, `#${w.ids.detailView} Pane: detail`);
      await t.key('ESC');
      const s = await t.waitFor(/ctrl\+x tab to work this pane from the keyboard/);
      expect(s).not.toMatch(/Tab moves · Enter presses/);
      // Keys now go to the prompt: a digit is text there, not a tab switch.
      await t.type('2');
      try {
        await t.waitFor(/^❯\s2\s*$/m, 3_000);
        expect(t.text()).not.toMatch(/Recently finished/);
      } finally {
        await t.key('BS'); // the prompt empty again, whatever happened
      }
      await t.key('FOCUS');
      await t.waitFor(/Tab moves · Enter presses/);
      // Taken back, the ring is where the person left it, not on the board's first row.
      await landsOn(t, `#${w.ids.detailView} Pane: detail`);
    });

    it('r refreshes: a task another session made shows at once', async () => {
      await w.api('POST', '/api/tasks', {
        title: 'Made in another session',
        created_by: 'agent-x',
      });
      await t.key('r');
      await t.waitFor(/Made in another session/, 4_000);
      expect(t.text()).toMatch(/^❯\s*$/m); // the key went to the pane, not the prompt
      expect(t.text()).toMatch(/13 open tasks/);
      expect(statusEntry(t)).toMatch(/13 open tasks/);
    });

    it('Find matches an id, an agent and a tag, and says which tag', async () => {
      await t.focus('Find');
      await t.type('r'); // in the field r is a letter, not Refresh
      await t.waitFor(/Find\s*:?\s*r\b/);
      await t.key('BS');
      await t.type(`#${w.ids.flaky}`);
      await t.enter();
      let s = await t.waitFor(/\d+ shown/);
      expect(s).toMatch(new RegExp(`#${w.ids.flaky} Investigate`));
      // An id is found in ids alone (the transcript beside the pane names other tasks).
      expect(paneLines(t).join(' ')).not.toMatch(/Ship muk_import/);
      await landsOn(t, `#${w.ids.flaky} Investigate`);

      await t.focus('Find');
      await t.key('BS', 6);
      await t.type('reviewer-1');
      await t.enter();
      s = await t.waitFor(/1 shown/);
      expect(s).toMatch(new RegExp(`#${w.ids.review} Review the REST changes`));

      await t.focus('Find');
      await t.key('BS', 12);
      await t.type('release');
      await t.enter();
      s = await t.waitFor(/6 shown/); // the ship task by its tag, five by their project
      expect(paneLines(t).join(' ')).not.toMatch(/Investigate flaky/);
      // The tag is nowhere else on a row: the row says it matched there.
      const row = s.split('\n').findIndex((l) => l.includes(`#${w.ids.ship} Ship`));
      expect(s.split('\n')[row + 1]).toMatch(/tag release/);
      expect(t.style('tag release', paneColumn(t)).fg).not.toBe(-1);
      shot(t, 'find-tag');
      await t.press('Clear the filter');
      await t.waitFor(/Find: id, title/);
      await landsOn(t, `#${w.ids.ship} Ship`);
    });

    it('back from a task opened on the board lands on its row', async () => {
      await t.press(`#${w.ids.badges} Tidy the README`);
      await t.waitFor(/‹ Board/);
      await t.press('‹ Board');
      await t.waitFor(/Backlog \d+/);
      await landsOn(t, `#${w.ids.badges} Tidy the README`);
    });

    it('/pipeline <unknown id> says there is no such task and shows the board', async () => {
      await t.key('ESC');
      await t.pipeline('9999');
      const s = await t.waitFor(/there is no task #9999/);
      expect(s).toMatch(/⎿[\s\S]*there is no task #9999/); // in the command's answer too
      await t.waitFor(/Backlog \d+/);
      await landsOn(t, /#\d+ /);
    });

    it('/pipeline <text> that matches nothing lands on Clear the filter', async () => {
      await t.key('ESC');
      await t.pipeline('zzz-nothing');
      const s = await t.waitFor(/No open task matches/);
      expect(s).toMatch(/0 open tasks match "zzz-nothing"/);
      expect(s).toMatch(/0 shown/);
      await landsOn(t, 'Clear the filter');
      shot(t, 'no-match');
      await t.enter();
      await t.waitFor(/Find: id, title/);
      await landsOn(t, `#${w.ids.ship} Ship`);
      expect(paneLines(t).join(' ')).not.toMatch(/\d+ shown/);
    });

    it('the mouse: tabs, rows, the back link, Refresh and the New form', async () => {
      const x = paneColumn(t);
      await t.click('Done', x);
      await t.waitFor(/Recently finished/);
      await t.click('Board', x);
      await t.waitFor(/Backlog \d+/);
      await t.click('Investigate flaky', x);
      await t.waitFor(/‹ Board/);
      expect(t.text()).toMatch(/Investigate flaky knowledge sync on Windows/);
      await t.click('‹ Board', x);
      await t.waitFor(/Backlog \d+/);
      await w.api('POST', '/api/tasks', { title: 'Clicked into view', created_by: 'agent-y' });
      await t.click('Refresh', x);
      await t.waitFor(/Clicked into view/, 4_000);

      await t.click('New', x);
      await t.waitFor(/New task/);
      await t.click('what needs doing', x); // the Title field's placeholder
      await t.type('Made with the mouse');
      await t.click('Create', x);
      const s = await t.waitFor(/created #\d+/);
      const id = Number(/created #(\d+)/.exec(s)![1]);
      const made = await w.task(id);
      expect(made).toMatchObject({ title: 'Made with the mouse', stage: 'backlog' });
      expect((made as unknown as { created_by: string }).created_by).toBe(ME);
      shot(t, 'mouse-created');
    });

    it('the ✕ closes the pane; /pipeline opens it again on the board', async () => {
      const x = paneColumn(t);
      await t.click('✕', x);
      await gone(t, /1: Board|Recently finished|‹ Board/);
      expect(statusEntry(t)).toMatch(/open tasks/); // the status entry stays
      await t.pipeline();
      await t.waitFor(/Backlog \d+/);
      await landsOn(t, /#\d+ /);
    });

    it('toasts: a failure says so, a cancellation does not, more than three are counted', async () => {
      await t.waitFor(/Backlog \d+/);
      await w.api('POST', `/api/tasks/${w.ids.harness}/stage`, {
        action: 'fail',
        result: 'Blocked too long',
        by: 'agent-e2e',
      });
      await t.waitFor(new RegExp(`Failed: #${w.ids.harness} Write the e2e harness`), 20_000);
      shot(t, 'toast-failed');

      // A cancellation is no news: the board changes, no toast says so.
      await w.api('POST', `/api/tasks/${w.ids.badges}/stage`, {
        action: 'cancel',
        reason: 'not needed',
        by: 'lead',
      });
      await gone(t, new RegExp(`#${w.ids.badges} Tidy the README`));
      expect(t.text()).not.toMatch(/Cancelled: |cancelled: #/);

      // Four tasks finish between two polls: three are named, the fourth counted.
      // One transaction, so no poll falls between them.
      const four = [w.ids.changelog, w.ids.serverJson, w.ids.wsTests, w.ids.pane];
      await w.domain((c) => four.forEach((id) => c.tasks.complete(id, 'done')));
      for (const id of four) await until(w, id, (x) => x.status === 'completed');
      // The toast's box runs under the docked pane, which hides what it covers: the count
      // at its end is what stays readable.
      await t.waitFor(/\+1 more/, 20_000);
      shot(t, 'toast-more');
    });
  });

  // ---------------------------------------------------------------------------
  // A long board: scrolling, a custom pipeline, long and wide titles
  // ---------------------------------------------------------------------------

  describe('a long board with a custom pipeline (fullscreen, 160 columns)', () => {
    let w: World;
    let t: ClaudeTerm;
    beforeAll(async () => {
      w = await startWorld(bigBoard);
      t = new ClaudeTerm(w, 160, 50, FULLSCREEN);
      await t.start();
      await t.pipeline();
      await t.waitFor(/Backlog \d+/);
    }, 2 * MIN);
    afterAll(async () => {
      await t?.kill();
      await w?.stop();
    }, 2 * MIN);

    it('a project with its own stages gets sections after the default ones', async () => {
      const s = paneLines(t).join(' ').replace(/\s+/g, ' ');
      expect(s).toMatch(/62 open tasks/);
      // The counts: the default stages, then the custom ones, each with its tasks.
      // (A line break between two counts drops the separator there.)
      expect(s).toMatch(
        /backlog 53(?: ·)? spec 2(?: ·)? implement 2(?: ·)? review 2(?: ·)? todo 1(?: ·)? draft 1(?: ·)? proof 1/,
      );
      shot(t, 'long-top');
      // Tab down to the custom sections: the pane scrolls with the ring.
      await t.focus('Proofread the FAQ', 120);
      const lines = paneLines(t);
      const at = (h: string) => lines.findIndex((l) => l.startsWith(h));
      expect(at('Todo 1')).toBeGreaterThanOrEqual(0);
      expect(at('Todo 1')).toBeLessThan(at('Draft 1'));
      expect(at('Draft 1')).toBeLessThan(at('Proof 1'));
      expect(t.text()).not.toMatch(/1: Board/); // scrolled: the tab bar is above the window
      shot(t, 'long-bottom');
      await t.enter();
      const d = await t.waitFor(/Proofread the FAQ/);
      expect(d).toMatch(/todo › draft › proof › published/);
      expect(d).toMatch(/Complete/); // proof is the last stage before published
    });

    it('↑ and ↓ scroll the board without moving the ring', async () => {
      await t.press('‹ Board');
      await t.waitFor(/Proofread the FAQ/);
      // Its digit puts the ring on the first row; the pane scrolls just far enough to show
      // it, the tab bar above stays out of view until ↑ scrolls there.
      await t.key('1');
      await landsOn(t, `#${w.more.long} Write the migration guide`);
      await t.key('UP', 10);
      await t.waitFor(/1: Board/);
      const ring = t.focused();
      expect(ring).toMatch(/Write the migration guide/);
      await t.key('DOWN', 15);
      await t.settle();
      expect(t.text()).not.toMatch(/1: Board/);
      await t.key('UP', 15);
      await t.settle();
      await t.waitFor(/1: Board/);
      expect(t.focused()).toBe(ring);
    });

    it('a long title is cut on its one line; its priority stays beside it', async () => {
      await t.key('1');
      await t.waitFor(new RegExp(`#${w.more.long} Write the migration guide`));
      const lines = paneLines(t);
      const row = lines.findIndex((l) => l.includes(`#${w.more.long} Write the migration guide`));
      expect(row).toBeGreaterThanOrEqual(0);
      expect(lines[row]).toMatch(/…\s+p9$/);
      expect(lines[row + 1]).toMatch(/^\s+unclaimed · docs · /);
      expect(t.text()).not.toMatch(/WebSocket clients/);
    });

    it('a title with wide characters stays on one line', async () => {
      const lines = paneLines(t);
      const row = lines.findIndex((l) => l.includes(`#${w.more.wide} `));
      expect(row).toBeGreaterThanOrEqual(0);
      expect(lines[row]).toMatch(/p7$/);
      expect(lines[row + 1]).toMatch(/^\s+unclaimed · i18n · /);
    });

    it('the long backlog folds past ten rows; Enter unfolds it and folds it again', async () => {
      await t.key('1');
      await t.waitFor(/▸ 43 more in backlog/);
      // Ten rows of it are drawn, the rest only counted: the stages at work stay in reach.
      expect(t.text()).toMatch(/Backlog 53/);
      expect(t.text()).not.toMatch(/Bulk task 45/);
      await t.focus('▸ 43 more in backlog', 40);
      await t.enter();
      await t.waitFor(/▾ Fold backlog/);
      // The ring goes to the first row the unfold showed, right under the toggle, which stays
      // where it was: the rows asked for are in view, not scrolled past.
      await landsOn(t, /^○ #\d+ /);
      const lines = t.text().split('\n');
      const toggle = lines.findIndex((l) => l.includes('▾ Fold backlog'));
      const row = lines.findIndex((l) => l.includes(`${t.focused()}`.slice(2, 30)));
      expect(toggle).toBeGreaterThan(-1);
      expect(row).toBe(toggle + 1);
      await t.key('SHIFTTAB');
      await landsOn(t, '▾ Fold backlog');
      await t.enter();
      await t.waitFor(/▸ 43 more in backlog/);
      await landsOn(t, '▸ 43 more in backlog');
    });
  });

  // ---------------------------------------------------------------------------
  // Nothing on the board
  // ---------------------------------------------------------------------------

  describe('an empty board (fullscreen, 120 columns)', () => {
    let w: World;
    let t: ClaudeTerm;
    beforeAll(async () => {
      w = await startWorld(undefined, { bare: true });
      t = new ClaudeTerm(w, 120, 40, FULLSCREEN);
      await t.start();
    }, 2 * MIN);
    afterAll(async () => {
      await t?.kill();
      await w?.stop();
    }, 2 * MIN);

    it('says nothing is open and offers a new task', async () => {
      expect(statusEntry(t)).toBe('0 open tasks · 0 in progress');
      await t.pipeline();
      const s = await t.waitFor(/Nothing open on the board\./);
      expect(s).toMatch(/Tasks agents create land here, by pipeline stage\./);
      expect(s).not.toMatch(/Find:/);
      await landsOn(t, 'New task');
      shot(t, 'empty');
    });

    it('Done says nothing finished yet; its digit again lands on the Board tab', async () => {
      await t.key('2');
      await t.waitFor(/Nothing finished yet\./);
      await t.key('2');
      await landsOn(t, 'Board');
      shot(t, 'empty-done');
    });

    it('New from the empty board creates the first task', async () => {
      await t.key('1');
      await landsOn(t, 'New task');
      await t.enter();
      await landsOn(t, 'Title');
      await t.type('The very first task');
      await t.focus('Create');
      await t.enter();
      await t.waitFor(/created #\d+/);
      const { open } = await w.api<{ open: { title: string }[] }>('GET', '/api/board');
      expect(open.map((x) => x.title)).toEqual(['The very first task']);
      await t.press('‹ Board');
      await t.waitFor(/1 open task\b/);
      expect(statusEntry(t)).toBe('1 open task · 0 in progress');
    });

    it('once all is finished the board points at Done', async () => {
      const { open } = await w.api<{ open: { id: number }[] }>('GET', '/api/board');
      const id = open[0]!.id;
      await w.api('POST', `/api/tasks/${id}/stage`, { action: 'claim', claimer: 'agent-z' });
      await w.api('POST', `/api/tasks/${id}/stage`, { action: 'complete', result: 'ok' });
      await t.key('r');
      await t.waitFor(/Nothing open on the board\./);
      await t.waitFor(/1 recent one under Done\./);
      await t.key('2');
      await t.waitFor(/✓ #\d+ The very first task/);
    });
  });

  // ---------------------------------------------------------------------------
  // Layouts: the narrow dock and the inline pane, every tab
  // ---------------------------------------------------------------------------

  describe('the narrow dock (fullscreen, 110 columns)', () => {
    let w: World;
    let t: ClaudeTerm;
    beforeAll(async () => {
      w = await startWorld(bigBoard);
      t = new ClaudeTerm(w, 110, 45, FULLSCREEN);
      await t.start();
      await t.pipeline();
      await t.waitFor(/Backlog \d+/);
    }, 2 * MIN);
    afterAll(async () => {
      await t?.kill();
      await w?.stop();
    }, 2 * MIN);

    it('board rows stay two lines, long and wide titles too', async () => {
      await t.focus(`#${w.more.wide} `, 80);
      const lines = paneLines(t);
      for (const id of [w.more.long, w.more.wide]) {
        const row = lines.findIndex((l) => l.includes(`#${id} `));
        expect(row).toBeGreaterThanOrEqual(0);
        expect(lines[row + 1]).toMatch(/^\s+unclaimed · /);
      }
      shot(t, 'narrow-long');
    });

    it('Done rows keep who, where and the result on their own lines', async () => {
      await t.key('2');
      const s = await t.waitFor(/Recently finished/);
      // Facts and result are each cut to their one line, never wrapped.
      expect(s).toMatch(/completed \S+ · agent-release · agen/);
      expect(s).toMatch(/Bumped; loopback bind/);
      expect(s).not.toMatch(/│\s*(?:tasks|request guard)/);
      shot(t, 'narrow-done');
    });

    it('New: every field hint fits beside its label', async () => {
      await t.key('3');
      const s = await t.waitFor(/New task/);
      for (const [label, hint] of [
        ['Title', 'what needs doing'],
        ['Project', 'groups the board'],
        ['Priority', '(?:whole number, higher goes first|integer, high first)'],
        ['Tags', 'comma separated'],
        ['Description', 'optional'],
      ])
        expect(s).toMatch(new RegExp(`${label}\\s+${hint}`));
      shot(t, 'narrow-new');
    });

    it('New: Clear empties what was typed and starts over in Title', async () => {
      await landsOn(t, 'Title');
      await t.type('Half a thought');
      await t.enter();
      await landsOn(t, 'Project');
      await t.type('scratch');
      await t.press('Clear');
      const s = await t.waitFor(/Title\s+what needs doing/);
      expect(s).toMatch(/Project\s+groups the board/);
      expect(s).not.toMatch(/Half a thought|scratch/);
      await landsOn(t, 'Title');
      const { open } = await w.api<{ open: { title: string }[] }>('GET', '/api/board');
      expect(open.some((x) => x.title === 'Half a thought')).toBe(false);
    });
  });

  describe('inline above the prompt (120 columns)', () => {
    let w: World;
    let t: ClaudeTerm;
    beforeAll(async () => {
      w = await startWorld();
      t = new ClaudeTerm(w, 120, 50);
      await t.start();
      await t.pipeline();
      await t.waitFor(/Backlog \d+/);
    }, 2 * MIN);
    afterAll(async () => {
      await t?.kill();
      await w?.stop();
    }, 2 * MIN);

    it('the board takes the keyboard: rows open with Enter', async () => {
      await landsOn(t, `#${w.ids.ship} Ship`);
      await t.enter();
      await t.waitFor(/‹ Board/);
      await t.press('‹ Board');
      await landsOn(t, `#${w.ids.ship} Ship`);
      shot(t, 'inline-board');
    });

    it('Done and New draw inline too', async () => {
      await t.key('2');
      await t.waitFor(/Recently finished/);
      expect(t.text()).toMatch(new RegExp(`✓ #${w.ids.bump} Bump agent-common`));
      shot(t, 'inline-done');
      await t.key('3');
      await t.waitFor(/New task/);
      await landsOn(t, 'Title');
      shot(t, 'inline-new');
      await t.type('Typed inline');
      for (const next of ['Project', 'Priority', 'Tags', 'Description']) {
        await t.enter();
        await landsOn(t, next);
      }
      await t.enter();
      const s = await t.waitFor(/created #\d+/);
      const id = Number(/created #(\d+)/.exec(s)![1]);
      expect((await w.task(id)).title).toBe('Typed inline');
    });
  });
});
