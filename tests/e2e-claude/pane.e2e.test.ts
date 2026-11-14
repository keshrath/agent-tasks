// =============================================================================
// The /pipeline pane in the real Claude Code CLI (AGENT_TASKS_E2E_CLAUDE=1,
// `npm run e2e:claude`). Needs a logged-in `claude` on PATH and a built dist/;
// slash commands and the pane make no model calls. Every flow is checked twice:
// on the screen text, and on the REST server's state after the action. Every
// view is captured to ~/.claude/tmp/pane-shots-tasks/e2e/<view>.png
// (AGENT_TASKS_E2E_SHOTS overrides). The fullscreen layout (the pane docked
// beside the conversation) is the one most people see; a narrow dock, the
// inline layout and the server going away are covered after it.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClaudeTerm, ME, SHOTS_DIR, sleep, startWorld, type Task, type World } from './harness.js';
import { renderShots } from './render.js';

const E2E = process.env.AGENT_TASKS_E2E_CLAUDE === '1';
const MIN = 60_000;
vi.setConfig({ testTimeout: 2 * MIN });

const FULLSCREEN = { CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1' };

/** The ring settles where the plugin lands it after a move. */
async function landsOn(t: ClaudeTerm, label: string | RegExp, ms = 5_000) {
  const hit = () => {
    const f = t.focused();
    return f !== null && (typeof label === 'string' ? f.includes(label) : label.test(f));
  };
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !hit()) await sleep(100);
  if (!hit())
    throw new Error(`the ring is not on ${label}:
${t.screen()}`);
}

/** Polls the REST server until `check` holds for the task (the pane acts asynchronously). */
async function until(w: World, id: number, check: (t: Task) => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  let last: Task | null = null;
  while (Date.now() < deadline) {
    last = await w.task(id);
    if (check(last)) return last;
    await sleep(200);
  }
  throw new Error(`#${id} never got there: ${JSON.stringify(last)}`);
}

/** The status line entry: the text the plugin hands `$.ui.status`, under the prompt. */
function statusEntry(t: ClaudeTerm): string | null {
  const lines = t.text().split('\n');
  const prompt = lines.findLastIndex((l) => l.startsWith('❯'));
  const below = lines.slice(prompt + 1).join('\n');
  return /agent-tasks: ([^\n]+)/.exec(below)?.[1]?.trim() ?? null;
}

// Scratch state is made in beforeAll: a describe body also runs when the suite is skipped.
describe.skipIf(!E2E)('/pipeline pane in Claude Code', () => {
  let w: World;
  beforeAll(async () => {
    w = await startWorld();
  }, 2 * MIN);
  afterAll(async () => {
    await w?.stop();
    await renderShots(SHOTS_DIR);
  }, 2 * MIN);

  describe('docked beside the conversation (fullscreen, 160 columns)', () => {
    let t: ClaudeTerm;
    beforeAll(async () => {
      t = new ClaudeTerm(w, 160, 50, FULLSCREEN);
      await t.start();
    }, 2 * MIN);
    afterAll(async () => t?.kill(), MIN);

    it('opens on the board by stage, the ring on the first task in progress', async () => {
      await t.pipeline();
      const s = await t.waitFor(/Backlog \d+/);
      expect(s).toMatch(/1: Board\s+2: Done\s+3: New\s+r: Refresh/);
      expect(s).toMatch(/Tab moves · Enter presses · ↑↓ scroll · Esc to the prompt/);
      expect(s).toMatch(/12 open tasks/);
      expect(s).toMatch(/6 in progress/);
      expect(s).toMatch(/1 blocked/);
      for (const stage of ['Backlog 6', 'Spec 2', 'Implement 2', 'Review 2'])
        expect(s).toContain(stage);
      expect(s).toMatch(new RegExp(`! #${w.ids.harness} Write the e2e harness for the real CLI`));
      expect(s).toMatch(new RegExp(`waits for #${w.ids.pane}`));
      expect(s).toMatch(new RegExp(`● #${w.ids.pane} Replace the web dashboard`));
      expect(s).toMatch(/agent-pane · 1\/2 subtasks · agent-tasks/);
      expect(s).toMatch(new RegExp(`○ #${w.ids.ship} Ship muk_import 19\\.0 to the customer`));
      // Finished tasks are under Done, not on the board.
      expect(s).not.toMatch(/Bump agent-common/);
      // The work in progress, not the unclaimed queue above it.
      await landsOn(t, `#${w.ids.harness} Write the e2e harness`);
      t.shot('board');
    });

    it('the status entry says what the board says', async () => {
      const entry = statusEntry(t);
      expect(entry).toMatch(/12 open tasks · 6 in progress · 1 blocked/);
      expect(
        t
          .text()
          .split('\n')
          .some((l) => l.includes(entry!) && l.includes('│')),
      ).toBe(true);
    });

    it('digits switch Board, Done and New while the pane holds the keyboard', async () => {
      // The tab shown takes its own digit: the ring back where the board starts, the prompt empty.
      await t.key('TAB', 3);
      await t.key('1');
      await landsOn(t, `#${w.ids.harness} Write the e2e harness`);
      expect(t.text()).toMatch(/^❯\s*$/m);
      await t.key('2');
      await t.waitFor(/Recently finished/);
      await t.key('3');
      await t.waitFor(/New task/);
      await landsOn(t, 'New'); // a tab switch lands on the tab, not in a field
      await t.key('3'); // pressed again: to type
      await landsOn(t, 'Title');
      // Digits in a field are text: the header drops them; in New, Tab goes to the next field.
      const typing = await t.waitFor(/Tab next field · Enter creates · Esc to the prompt/);
      expect(typing).not.toMatch(/1: Board/);
      expect(typing).toMatch(/Board\s+Done\s+New\s+Refresh/);
      await t.focus('Create'); // on a button they switch tabs again
      await t.waitFor(/1: Board\s+2: Done\s+3: New\s+r: Refresh/);
      await t.key('1');
      await t.waitFor(/Backlog \d+/);
    });

    it('Done lists what finished, newest first, its result beneath', async () => {
      await t.key('2');
      const s = await t.waitFor(/Recently finished/);
      expect(s).toMatch(new RegExp(`✓ #${w.ids.bump} Bump agent-common to 1\\.1\\.2`));
      // Who and where first, the result on a line of its own (a failure's in red).
      expect(s).toMatch(
        /completed \S+ · agent-release · agent-tasks\n[^\n]*│\s+Bumped; loopback bind/,
      );
      expect(s).toMatch(
        new RegExp(`✗ #${w.ids.screenshots} Migrate the old dashboard screenshots`),
      );
      expect(s).toMatch(
        /failed \S+ · agent-docs · agent-tasks\n[^\n]*│\s+The screenshots are gone/,
      );
      expect(s).toMatch(new RegExp(`– #${w.ids.duplicate} Duplicate of the dashboard task`));
      expect(s.indexOf(`#${w.ids.duplicate} `)).toBeLessThan(s.indexOf(`#${w.ids.boardView} `));
      t.shot('done');
      await t.key('2'); // pressed again it lands on the newest
      await landsOn(t, `#${w.ids.duplicate} Duplicate`);
      await t.press(`#${w.ids.screenshots} Migrate`);
      const d = await t.waitFor(/Error\s+The screenshots are gone with the dashboard/);
      expect(d).toMatch(/✗ failed · agent-docs · agent-tasks/);
      expect(d).toMatch(/‹ Done/);
      t.shot('detail-failed');
      await t.press('‹ Done');
      await t.waitFor(/Recently finished/);
      await landsOn(t, `#${w.ids.screenshots} Migrate`); // back on the row it came from
    });

    it('a task in progress: stage strip, facts, description, subtasks, artifacts, comments', async () => {
      await t.key('1');
      await t.waitFor(/Backlog \d+/);
      await t.press(`#${w.ids.pane} Replace the web dashboard`);
      const s = await t.waitFor(/Acceptance:/);
      expect(s).toMatch(/● in progress · agent-pane · p8 · agent-tasks/);
      expect(s).toMatch(/backlog › spec › plan › implement › test › review › done/);
      // Each related task carries its board mark: the harness waits, so `!`.
      expect(s).toMatch(new RegExp(`Blocks\\s+! #${w.ids.harness} Write the e2e harness`));
      // A link that does not block, with the linked task's own mark and stage on one line.
      expect(s).toMatch(
        new RegExp(
          `Duplicate\\s+– #${w.ids.duplicate} Duplicate of the dashboard task · cancelled`,
        ),
      );
      expect(s).toMatch(/Tags\s+ui, plugin/);
      expect(s).toMatch(/Subtasks 1\/2 done/);
      expect(s).toMatch(new RegExp(`✓ #${w.ids.boardView} Pane: board view`));
      expect(s).toMatch(/Artifacts 1/);
      expect(s).toMatch(/Comments 2/);
      expect(s).toMatch(/Make sure it works docked at 60 columns\./);
      expect(s).not.toMatch(/version 2\.0\.0/); // the description folds past its first lines
      await landsOn(t, '‹ Board'); // never on Advance by itself
      expect(t.text()).toMatch(/Advance › test/); // the next step, there to press
      t.shot('detail');

      // A fold keeps the ring on its toggle, unfolded and folded again.
      await t.press(/Show all \d+ lines/);
      await t.waitFor(/- version 2\.0\.0/);
      await landsOn(t, '▾ Show less');

      await t.press('▸ spec');
      const a = await t.waitFor(/Board by stage/);
      expect(a).toMatch(/▾ spec/);
      expect(a).toMatch(/- Detail with actions/);
      await landsOn(t, '▾ spec');
      t.shot('artifact');
      await t.enter();
      await t.waitFor(/▸ spec/);
      await landsOn(t, '▸ spec');
      await t.press('▾ Show less');
      await t.waitFor(/▸ Show all \d+ lines/);
      await landsOn(t, /Show all \d+ lines/);
    });

    it('a comment is sent from its field and kept as the person', async () => {
      // Three from the agents first: the person's is the sixth, which folds the oldest away.
      for (const n of [1, 2, 3])
        await w.api('POST', `/api/tasks/${w.ids.pane}/comments`, {
          content: `Progress note ${n}`,
          agent_id: 'agent-pane',
        });
      await t.focus('Comment');
      await t.type('Docked at 60 columns looks right.');
      await t.enter();
      await t.waitFor(/Comments 6/);
      // The ring leaves the field (a /pipeline typed next goes to the prompt, not into a
      // comment) for the comments' fold right above them: the new one stays in sight.
      await landsOn(t, '▸ 1 more');
      expect(t.text()).toMatch(/▸ 1 more/);
      await t.waitFor(/Docked at 60 columns looks right\./); // scrolled into view once drawn
      const { comments } = await w.api<{ comments: { agent_id: string; content: string }[] }>(
        'GET',
        `/api/tasks/${w.ids.pane}?include=comments`,
      );
      expect(comments.at(-1)).toMatchObject({
        agent_id: ME,
        content: 'Docked at 60 columns looks right.',
      });
      t.shot('comment');
    });

    it('/pipeline <id> opens a task; Advance moves it on, once', async () => {
      await t.key('ESC'); // the keyboard back to the prompt
      await t.pipeline(`#${w.ids.changelog}`);
      await t.waitFor(/Write the CHANGELOG 2\.0\.0 entry/);
      await landsOn(t, '‹ Board');
      await t.press('Advance › plan');
      await until(w, w.ids.changelog, (x) => x.stage === 'plan');
      const s = await t.waitFor(/moved to plan/);
      expect(s).toMatch(/backlog › spec › plan › implement/);
      // The ring goes to the way out: a second Enter does not move it a stage further.
      await landsOn(t, '‹ Board');
      await t.waitFor(/Advance › implement/);
      t.shot('advanced');
    });

    it('Send back asks for the stage and why', async () => {
      await t.press('‹ Send back');
      const s = await t.waitFor(/Send #\d+ back to an earlier stage/);
      expect(s).toMatch(/Back to/);
      // The form starts on its stage picker (open while it has the ring): the stage is picked
      // first, then the ring moves on to the note.
      await t.waitFor(/▴/);
      t.shot('form-send-back');
      await t.key('UP');
      await t.key('ENTER');
      await t.waitFor(/Back to\s+backlog/);
      await landsOn(t, 'Why');
      await t.type('The spec misses the migration notes');
      await t.enter();
      await until(w, w.ids.changelog, (x) => x.stage === 'backlog');
      await t.waitFor(/back to backlog/);
      // Not on Advance: one Enter there would undo the rejection.
      await landsOn(t, '‹ Board');
    });

    it('a task in its last stage completes with a result', async () => {
      await t.key('ESC');
      await t.pipeline(String(w.ids.serverJson));
      await t.waitFor(/Bump server\.json to 2\.0\.0/);
      await landsOn(t, '‹ Board');
      await t.press(/^(\[ )?Complete( \])?$/); // review is the last stage before done
      await t.waitFor(/Complete #\d+/);
      await landsOn(t, 'Result');
      t.shot('form-complete');
      await t.type('server.json is on 2.0.0 in both places');
      await t.enter();
      const done = await until(w, w.ids.serverJson, (x) => x.status === 'completed');
      expect(done.result).toBe('server.json is on 2.0.0 in both places');
      const s = await t.waitFor(/✓ completed/);
      expect(s).toMatch(/Result\s+server\.json is on 2\.0\.0 in both places/);
      expect(s).not.toMatch(/\[ Complete \]/);
    });

    it('Fail asks what went wrong; Never mind leaves the task alone', async () => {
      await t.key('ESC');
      await t.pipeline(String(w.ids.wsTests));
      await t.waitFor(/Port the WebSocket tests/);
      await landsOn(t, '‹ Board'); // the task's own landing first: a press then starts from it
      await t.press(/^\[ Fail \]$|^Fail$/);
      await t.waitFor(/Mark #\d+ failed/);
      await t.press('Never mind');
      await t.waitFor(/\[ Fail \]/);
      await landsOn(t, '[ Fail ]'); // back on the button that opened the form
      expect(t.text()).not.toMatch(/Mark #\d+ failed/);
      expect((await w.task(w.ids.wsTests)).status).toBe('in_progress');

      await t.press(/^\[ Fail \]$|^Fail$/);
      await landsOn(t, 'Error');
      t.shot('form-fail');
      await t.type('The WebSocket is gone with the dashboard');
      // The form's own button sends what was typed, as Enter in the field does.
      await t.press(/^\[ Fail \]$|^Fail$/);
      const failed = await until(w, w.ids.wsTests, (x) => x.status === 'failed');
      expect(failed.result).toBe('The WebSocket is gone with the dashboard');
      // The form's field holds the same words: wait for the outcome, then the Error fact.
      await t.waitFor(new RegExp(`– #${w.ids.wsTests} marked failed`));
      await t.waitFor(/Error\s+The WebSocket is gone with the dashboard/);
      expect(t.text()).not.toMatch(/✓ #\d+ failed/);
    });

    it('Cancel asks why and drops the task', async () => {
      await t.key('ESC');
      await t.pipeline(String(w.ids.restyle));
      await t.waitFor(/Restyle the kanban columns/);
      await landsOn(t, '‹ Board');
      await t.press(/^\[ Cancel \]$|^Cancel$/);
      await t.waitFor(/Cancel #\d+/);
      await landsOn(t, 'Reason');
      t.shot('form-cancel');
      await t.type('No dashboard any more');
      await t.enter();
      const gone = await until(w, w.ids.restyle, (x) => x.status === 'cancelled');
      expect(gone.result).toMatch(/No dashboard any more/);
      await t.waitFor(/– cancelled/);
      // The outcome replaces the busy line once the reload is drawn, a moment after the facts.
      await t.waitFor(new RegExp(`– #${w.ids.restyle} cancelled`));
    });

    it('Delete asks first: Keep it keeps it, Delete #N deletes it', async () => {
      await t.key('ESC');
      await t.pipeline(String(w.ids.darkMode));
      await t.waitFor(/Dark-mode toggle for the dashboard/);
      await landsOn(t, '‹ Board');
      await t.press(/^\[ Delete \]$|^Delete$/);
      const s = await t.waitFor(/Delete #\d+ with its artifacts and comments\? There is no undo\./);
      expect(s).toMatch(/\[ Keep it \] \[ Delete #\d+ \]/); // the safe answer first
      await landsOn(t, 'Keep it'); // and it has the focus
      t.shot('confirm-delete');
      await t.enter();
      await t.waitFor(/\[ Cancel \]/);
      await landsOn(t, '[ Delete ]');
      expect((await w.task(w.ids.darkMode)).title).toBe('Dark-mode toggle for the dashboard');

      await t.press(/^\[ Delete \]$|^Delete$/);
      await t.waitFor(/There is no undo/);
      await t.press(/^\[ Delete #\d+ \]$|^Delete #\d+$/);
      await t.waitFor(new RegExp(`#${w.ids.darkMode} deleted`));
      await expect(w.task(w.ids.darkMode)).rejects.toThrow(/404/);
      const board = await t.waitFor(/Backlog \d+/);
      // Gone from the pane (right of its border); /pipeline 16 named it in the transcript.
      const pane = board.split('\n').map((l) => l.split('│').slice(1).join('│'));
      expect(pane.join('\n')).not.toMatch(/Dark-mode toggle/);
    });

    it('a blocked task cannot move on and points at what it waits for', async () => {
      await t.key('ESC');
      await t.pipeline(String(w.ids.harness));
      const s = await t.waitFor(/Waits for/);
      expect(s).toMatch(/! blocked · agent-e2e · p5 · agent-tasks/);
      expect(s).toMatch(new RegExp(`Waits for\\s+● #${w.ids.pane} Replace the web dashboard`));
      await landsOn(t, `#${w.ids.pane} Replace`);
      t.shot('detail-blocked');
      expect(s).not.toMatch(/Advance ›/);
      // Neither moving on nor finishing is offered: no Complete the focus can reach.
      await expect(t.focus(/Complete/, 25)).rejects.toThrow(/focus never reached/);
      // And the server refuses it too.
      await expect(
        w.api('POST', `/api/tasks/${w.ids.harness}/stage`, { action: 'complete', result: 'x' }),
      ).rejects.toThrow(/[Bb]lock|depend/);
      const still = await w.task(w.ids.harness);
      expect([still.stage, still.status]).toEqual(['spec', 'in_progress']);
    });

    it('New: Tab walks the fields at typing speed, nothing lost; Enter creates the task', async () => {
      await t.focus('‹ Board');
      await t.key('3');
      await t.waitFor(/New task/);
      await t.key('3'); // the tab pressed again: to type
      await landsOn(t, 'Title');
      // Typed as a person types, field to field with no pause: every key lands where it is meant.
      await t.type('Record the /pipeline tutorial', 0);
      await t.key('TAB');
      await t.type('docs', 0);
      await t.key('TAB');
      await t.type('high', 0);
      await t.enter();
      // A priority that is no number: said beneath its own field, the ring kept there.
      await t.waitFor(/Priority\s+high.*\n.*a whole number, like 0 or 5/);
      expect(t.text()).toMatch(/Title\s+Record the \/pipeline tutorial/);
      expect(t.text()).toMatch(/Project\s+docs/);
      await landsOn(t, 'Priority');
      await t.key('BS', 4);
      await t.type('4', 0);
      await t.key('TAB');
      await t.type('docs, ui', 0);
      await t.key('TAB');
      await landsOn(t, 'Description');
      await t.type('From the real CLI, docked and wide', 0);
      t.shot('new-task');
      await t.enter();
      const s = await t.waitFor(/created #\d+/);
      const id = Number(/created #(\d+)/.exec(s)![1]);
      // The outcome names the task by number alone: one line in any dock.
      expect(s).toMatch(new RegExp(`✓ created #${id}[ │]*$`, 'm'));
      await t.waitFor(/Record the \/pipeline tutorial/);
      const made = await w.task(id);
      expect(made).toMatchObject({
        title: 'Record the /pipeline tutorial',
        project: 'docs',
        priority: 4,
        stage: 'backlog',
        status: 'pending',
        description: 'From the real CLI, docked and wide',
      });
      expect(JSON.parse(made.tags ?? '[]')).toEqual(['docs', 'ui']);
      expect((made as unknown as { created_by: string }).created_by).toBe(ME);
      t.shot('new-task-created');
    });

    it('Find narrows the board by text, a project name too', async () => {
      await t.press(/‹ Board/);
      const b0 = await t.waitFor(/Backlog \d+/);
      expect(b0).toMatch(/Find: id, title, agent, project or tag/);
      expect(b0).not.toMatch(/Project:/); // Find matches projects: no select of its own
      await t.focus('Find');
      await t.type('odoo-addons');
      await t.enter();
      const s = await t.waitFor(/1 shown/);
      expect(s).toMatch(new RegExp(`#${w.ids.ship} Ship muk_import`));
      await landsOn(t, `#${w.ids.ship} Ship muk_import`); // the first row the find shows
      expect(s).not.toMatch(/Investigate flaky knowledge sync/);
      t.shot('board-project');

      await t.focus('Find');
      await t.type('flaky'); // added to the text: odoo-addonsflaky
      await t.enter();
      await t.waitFor(/No open task matches/);
      t.shot('board-no-match');
      await t.press('Clear the filter');
      const all = await t.waitFor(/Find: id, title/);
      expect(all).toMatch(/Investigate flaky knowledge sync/);
      expect(all).toMatch(/Ship muk_import/);

      await t.key('ESC');
      await t.pipeline('flaky');
      const f = await t.waitFor(/Find: flaky/);
      expect(f).not.toMatch(/open task matches "flaky"/); // the pane says it: no transcript line
      expect(f).toMatch(new RegExp(`#${w.ids.flaky} Investigate flaky knowledge sync`));
      expect(f).not.toMatch(/Ship muk_import/);
      await landsOn(t, `#${w.ids.flaky} Investigate`);
      expect(f).toMatch(/Clear the filter/);
      t.shot('board-find');

      // A task opened by id drops the text the last /pipeline found.
      await t.key('ESC');
      await t.pipeline(String(w.ids.flaky));
      await t.press('‹ Board');
      const b = await t.waitFor(/Backlog \d+/);
      expect(b).toMatch(/Ship muk_import/);
      expect(b).not.toMatch(/Clear the filter/);
    });

    // `/pipeline <text>` over and over, the pane open and polling: each find draws a board
    // whose rows the last one drew too, at other places. The ring lands on the first match
    // every time, never on whatever took the place the row had on the board before.
    it('/pipeline <text> lands on the first match every time', async () => {
      const finds: [string, RegExp][] = [
        ['flaky', new RegExp(`#${w.ids.flaky} Investigate`)],
        ['README', new RegExp(`#${w.ids.badges} Tidy the README`)],
        ['', /#\d+ /],
      ];
      for (let i = 0; i < 12; i++) {
        const [text, row] = finds[i % finds.length]!;
        await t.key('ESC');
        await t.pipeline(text);
        await landsOn(t, row);
      }
    });

    it('changes from other sessions toast and update the status entry', async () => {
      await t.press(`#${w.ids.flaky} Investigate`);
      await t.press('‹ Board');
      await t.waitFor(/Backlog \d+/);
      const before = statusEntry(t);
      // Another session's reviewer finishes the review, another moves the pane work on.
      await w.api('POST', `/api/tasks/${w.ids.review}/stage`, {
        action: 'complete',
        result: 'LGTM',
        by: 'reviewer-1',
      });
      await w.api('POST', `/api/tasks/${w.ids.pane}/stage`, {
        action: 'advance',
        by: 'agent-pane',
      });
      await w.api('POST', `/api/tasks/${w.ids.pane}/stage`, {
        action: 'advance',
        by: 'agent-pane',
      });
      expect((await w.task(w.ids.pane)).stage).toBe('review');
      // One toast for both, the news first. It wraps inside its box, and where the box runs
      // under the docked pane the engine hides the cells it covers ("Ready" among them).
      await t.waitFor(new RegExp(`Done: #${w.ids.review} Review the REST changes`), 20_000);
      expect(t.text()).toMatch(new RegExp(`for review: #${w.ids.pane} Replace`));
      t.shot('toast');
      const deadline = Date.now() + 10_000;
      while (statusEntry(t) === before && Date.now() < deadline) await sleep(250);
      expect(statusEntry(t)).not.toBe(before);
      expect(statusEntry(t)).toMatch(/\d+ open tasks/);
    });
  });

  describe('docked narrow (fullscreen, 110 columns)', () => {
    let t: ClaudeTerm;
    beforeAll(async () => {
      t = new ClaudeTerm(w, 110, 45, FULLSCREEN);
      await t.start();
      await t.pipeline();
      await t.waitFor(/Backlog \d+/);
    }, 2 * MIN);
    afterAll(async () => t?.kill(), MIN);

    it('board, detail, forms, New and Done fit the narrow sidebar', async () => {
      const s = t.text();
      expect(s).toMatch(/1: Board\s+2: Done\s+3: New\s+r: Refresh/);
      expect(s).toMatch(/Esc to the prompt/); // the key hint shortens, never cut
      // The summary breaks between its parts; nothing is cut away.
      expect(s).toMatch(/open tasks[\s\S]*in progress[\s\S]*1 blocked/);
      // One line per title: a cut title ends in … on its own line, never on the next.
      expect(s).not.toMatch(/│\s*…\s*$/m);
      // A wrapped summary line never starts on a separator.
      expect(s).not.toMatch(/│\s*[·›]\s/);
      expect(s).not.toMatch(/\s[·›]\s*$/m); // nor ends on one
      t.shot('narrow-board');
      await t.press(`#${w.ids.pane} Replace`);
      // A linked task's title wraps, never cut; its stage follows it.
      const d = await t.waitFor(/Duplicate\s+– #\d+ [\s\S]*?· cancelled/);
      expect(d).toMatch(/\[ Complete \]/);
      expect(d).not.toMatch(/│\s*[·›]\s/);
      expect(d).not.toMatch(/\s[·›]\s*$/m); // no line ends on a separator either
      t.shot('narrow-detail');
      // Labels sit in their column and hints stay on the field's line.
      await t.press('Send back');
      await t.waitFor(/Back to/);
      await t.focus('Why');
      expect(t.text()).toMatch(/Why\s+optional note ⏎ send/);
      t.shot('narrow-form');
      await t.press('Never mind');
      await landsOn(t, '‹ Send back');
      await t.focus('‹ Board');
      await t.key('3');
      await t.waitFor(/New task/);
      t.shot('narrow-new');
      await t.focus('Create');
      await t.key('2');
      await t.waitFor(/Recently finished/);
      t.shot('narrow-done');
    });
  });

  describe('inline above the prompt (120 columns)', () => {
    let t: ClaudeTerm;
    beforeAll(async () => {
      t = new ClaudeTerm(w, 120, 50);
      await t.start();
    }, 2 * MIN);
    afterAll(async () => t?.kill(), MIN);

    it('opens the board above the prompt', async () => {
      await t.pipeline();
      const s = await t.waitFor(/Backlog \d+/);
      expect(s).toMatch(/1: Board\s+2: Done\s+3: New\s+r: Refresh/);
      expect(s).toMatch(/open tasks/);
      t.shot('inline-board');
    });
  });

  describe('when the REST server is gone', () => {
    let t: ClaudeTerm;
    beforeAll(async () => {
      t = new ClaudeTerm(w, 120, 40, FULLSCREEN);
      await t.start();
      await t.pipeline();
      await t.waitFor(/Backlog \d+/);
    }, 2 * MIN);
    afterAll(async () => t?.kill(), MIN);

    it('says so instead of showing a stale board, and Refresh brings it back', async () => {
      await w.stopServer();
      await t.key('r');
      const s = await t.waitFor(/not reachable/);
      expect(s).toMatch(/Nothing answers at/);
      expect(s).toContain(`http://127.0.0.1:${w.port}`);
      expect(s).not.toMatch(/Backlog \d+/);
      expect(s).toMatch(/r: Refresh/);
      expect(s).toMatch(/2: Done\s+3: New/); // the tabs stay, so a digit stays in the pane
      await landsOn(t, 'Refresh');
      expect(statusEntry(t)).toBe('offline'); // no stale counts under the prompt
      await t.enter();
      // A Refresh says it tried, and when (wrapped in the 40-column pane).
      const tried = await t.waitFor(/✗ still nothing answers at/);
      const pane = tried
        .split('\n')
        .map((l) => l.split('│').slice(1).join('│').trim())
        .join(' ');
      expect(pane).toMatch(/still nothing answers at http:\/\/127\.0\.0\.1:\d+ \(\d\d:\d\d:\d\d\)/);
      t.shot('server-down');

      await w.startServer();
      await t.enter();
      await t.waitFor(/Backlog \d+/);
      await t.waitFor(/agent-tasks: \d+ open tasks/);
      await landsOn(t, /#\d+ /);
    });
  });
});

// ---------------------------------------------------------------------------
// Other sessions change what the pane shows while it holds the keyboard: the
// ring stays on the control the person left it on, nothing lands in a field.
// ---------------------------------------------------------------------------

describe.skipIf(!E2E)('/pipeline while other sessions change the board', () => {
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

  it('a task claimed and one raised above the ring move no row under it; Enter opens the task it is on', async () => {
    await t.pipeline();
    await t.waitFor(/Backlog \d+/);
    await t.focus(`#${w.ids.flaky} Investigate`);
    // Another session claims the backlog's first task (it leaves for spec) and raises its last.
    await w.api('POST', `/api/tasks/${w.ids.ship}/stage`, { action: 'claim', claimer: 'agent-x' });
    await w.domain((c) =>
      c.db.run(`UPDATE tasks SET priority = 99 WHERE id = ?`, [w.ids.darkMode]),
    );
    await t.waitFor(new RegExp(`Spec 3`), 15_000);
    await sleep(6_000); // one more poll: still where it was
    await landsOn(t, `#${w.ids.flaky} Investigate`);
    await t.enter();
    await t.waitFor(/‹ Board[\s\S]*Investigate flaky knowledge sync on Windows/);
  });

  it('an artifact attached elsewhere above the comment field leaves the ring in the field', async () => {
    await t.key('ESC');
    await t.pipeline(String(w.ids.pane));
    await t.waitFor(/Replace the web dashboard/);
    await t.focus('Comment');
    await landsOn(t, 'Comment'); // the field holds the ring (its hint may scroll out of view)
    await w.domain((c) =>
      c.tasks.addArtifact(w.ids.pane, 'design', 'The layout, docked.', 'agent-pane'),
    );
    await t.waitFor(/▸ design/, 20_000);
    await sleep(1_000);
    await landsOn(t, 'Comment');
    await t.type('k');
    // Typed into the field (the ring's marks aside), not into the prompt.
    for (let i = 0; i < 40 && !/Comment:\s+k/.test(t.text()); i++) await sleep(100);
    expect(t.text()).toMatch(/Comment:\s+k/);
    await t.key('BS');
  });

  it('r refreshes and leaves the ring where it was, so r and Enter never advance a task', async () => {
    await t.key('TAB');
    await t.focus(/^(\[ )?Fail( \])?$/);
    await t.key('ESC');
    await t.key('FOCUS');
    await landsOn(t, /^(\[ )?Fail( \])?$/);
    await t.key('r');
    await sleep(1_500);
    await landsOn(t, /^(\[ )?Fail( \])?$/);
  });

  it('a form whose task was finished elsewhere closes and says nothing was sent', async () => {
    await t.press(/^(\[ )?Fail( \])?$/);
    await landsOn(t, 'Error');
    await t.type('half a reason');
    await w.api('POST', `/api/tasks/${w.ids.pane}/stage`, {
      action: 'complete',
      result: 'finished in another session',
      by: 'agent-pane',
    });
    await t.waitFor(/changed elsewhere \(now completed\): nothing was sent/, 25_000);
    // The closed form's field goes with it (waited for, not read off the notice's frame).
    for (let i = 0; i < 50 && /half a reason/.test(t.text()); i++) await sleep(100);
    expect(t.text()).not.toMatch(/half a reason/);
    expect((await w.task(w.ids.pane)).result).toBe('finished in another session');
  });

  /** A task in progress at implement, made for one test. */
  const working = (title: string) =>
    w.domain((c) => {
      const { id } = c.tasks.create({ title, project: 'race' }, 'lead');
      c.tasks.claim(id, 'agent-r');
      c.tasks.advance(id);
      c.tasks.advance(id);
      return id;
    });

  it('a Complete form closed by a move elsewhere lands on Complete, never on Advance; the words come back', async () => {
    const id = await working('Moved while the form was open');
    await t.key('ESC');
    await t.pipeline(String(id));
    await t.waitFor(/Moved while the form was open/);
    await landsOn(t, '‹ Board');
    await t.press(/^(\[ )?Complete( \])?$/);
    await landsOn(t, 'Result');
    await t.type('half a result');
    await w.api('POST', `/api/tasks/${id}/stage`, { action: 'advance', by: 'agent-r' });
    await t.waitFor(
      /changed elsewhere \(now test\): nothing was sent, what you typed is kept/,
      25_000,
    );
    await landsOn(t, /^(\[ )?Complete( \])?$/, 10_000);
    // The header is the keys' again, not a field's.
    expect(t.text()).toMatch(/1: Board\s+2: Done/);
    // Enter there, once the person sees it, opens the form with the words; nothing moved the task.
    await t.settle(500, 3_000);
    await t.enter();
    await t.waitFor(/Result\s+half a result/);
    expect((await w.task(id)).stage).toBe('test');
    await t.press('Never mind');
  });

  it('Done right after a task finished elsewhere lands on its newest row, the tabs in sight', async () => {
    for (const n of [1, 2, 3]) {
      const id = await working(`Finished elsewhere ${n}`);
      await t.key('ESC');
      await t.pipeline();
      await t.waitFor(new RegExp(`Finished elsewhere ${n}`));
      await w.api('POST', `/api/tasks/${id}/stage`, {
        action: 'complete',
        result: 'done elsewhere',
        by: 'agent-r',
      });
      // The poll took it off the board: it is in Done now.
      for (let i = 0; i < 150 && new RegExp(`#${id} Finished elsewhere`).test(t.text()); i++)
        await sleep(100);
      await t.key('2');
      await landsOn(t, new RegExp(`#${id} Finished elsewhere ${n}`));
      expect(t.text()).toMatch(/1: Board\s+2: Done\s+3: New/);
    }
  });

  it('Delete of a parent with work open below says so and offers only Back', async () => {
    const [parent, child] = await w.domain((c) => {
      const p = c.tasks.create({ title: 'Parent with open work', project: 'race' }, 'lead');
      const k = c.tasks.create({ title: 'Open child', project: 'race', parent_id: p.id }, 'lead');
      c.tasks.claim(k.id, 'agent-other');
      return [p.id, k.id];
    });
    await t.key('ESC');
    await t.pipeline(String(parent));
    await t.waitFor(/Parent with open work/);
    await t.press(/^\[ Delete \]$|^Delete$/);
    const s = await t.waitFor(/has open subtasks/);
    expect(s).not.toMatch(/Delete #\d+ \]/);
    await landsOn(t, 'Back');
    await t.enter();
    await t.waitFor(/\[ Cancel \] \[ Delete \]/);
    expect((await w.task(child)).status).toBe('in_progress');
    expect((await w.task(parent)).title).toBe('Parent with open work');
  });

  it('Clear on New lands on Clear: a digit typed next switches tabs, it makes no task', async () => {
    await t.key('ESC');
    await t.pipeline();
    await t.waitFor(/Backlog \d+/);
    const before = (await w.api<{ open: unknown[] }>('GET', '/api/board')).open.length;
    await t.key('3');
    await t.key('3');
    await landsOn(t, 'Title');
    await t.type('scratch');
    await t.focus('Clear');
    await t.enter();
    await landsOn(t, 'Clear');
    await t.key('1');
    await t.waitFor(/Backlog \d+/);
    await t.pipeline('37');
    await t.settle();
    expect((await w.api<{ open: unknown[] }>('GET', '/api/board')).open.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Typing at speed: every key arrives, in order, in the field it was typed into, also
// while other sessions change the task the field belongs to; nothing reaches the prompt.
// ---------------------------------------------------------------------------

/** Types `text` one key at a time, `ms` apart, as a fast typist does. */
async function typeAt(t: ClaudeTerm, text: string, ms: number) {
  for (const ch of text) await t.type(ch, ms);
  await sleep(300);
}

/** What the screen shows left of the pane: the conversation and its prompt. */
const outside = (t: ClaudeTerm) =>
  t
    .text()
    .split('\n')
    .map((l) => l.split('│')[0])
    .join('\n');

describe.skipIf(!E2E)('/pipeline fields typed into at speed', () => {
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
      const { id } = c.tasks.create({ title, project: 'speed' }, 'lead');
      c.tasks.claim(id, 'agent-s');
      c.tasks.advance(id);
      return id;
    });

  it('New: every field at 25 ms a key arrives whole', async () => {
    await t.pipeline();
    await t.waitFor(/Backlog \d+/);
    await t.key('3');
    await t.key('3');
    await landsOn(t, 'Title');
    await typeAt(t, 'Typed at twenty-five ms a key', 25);
    await t.key('TAB');
    await typeAt(t, 'speedy-project', 25);
    await t.key('TAB');
    await typeAt(t, '7', 25);
    await t.key('TAB');
    await typeAt(t, 'fast, keys', 25);
    await t.key('TAB');
    await typeAt(t, 'Every key in its place.', 25);
    await t.enter();
    const s = await t.waitFor(/created #(\d+)/);
    const id = Number(/created #(\d+)/.exec(s)![1]);
    expect(await w.task(id)).toMatchObject({
      title: 'Typed at twenty-five ms a key',
      project: 'speedy-project',
      priority: 7,
      description: 'Every key in its place.',
    });
    expect(JSON.parse(String((await w.task(id)).tags))).toEqual(['fast', 'keys']);
  });

  it('a comment and a Fail reason at 25 ms a key arrive whole', async () => {
    const id = await working('Typed into at speed');
    await t.key('ESC');
    await t.pipeline(String(id));
    await t.waitFor(/Typed into at speed/);
    await t.focus('Comment');
    await typeAt(t, 'A comment typed at twenty-five ms, every key kept.', 25);
    await t.enter();
    await t.waitFor(/comment added/);
    const { comments } = await w.api<{ comments: { content: string }[] }>(
      'GET',
      `/api/tasks/${id}?include=comments`,
    );
    expect(comments.at(-1)?.content).toBe('A comment typed at twenty-five ms, every key kept.');
    await t.press(/^\[ Fail \]$|^Fail$/);
    await landsOn(t, 'Error');
    await typeAt(t, 'Failed on purpose, typed fast.', 25);
    await t.enter();
    const failed = await until(w, id, (x) => x.status === 'failed');
    expect(failed.result).toBe('Failed on purpose, typed fast.');
  });

  it('Find at 25 ms a key finds what was typed', async () => {
    await t.key('ESC');
    await t.pipeline();
    await t.waitFor(/Backlog \d+/);
    await t.focus('Find');
    await typeAt(t, 'speedy-project', 25);
    await t.enter();
    await t.waitFor(/1 shown/);
    expect(t.text()).toMatch(/Typed at twenty-five ms a key/);
    await t.press('Clear the filter');
  });

  it('a comment typed at 40 ms while other sessions claim, advance and comment: every key in the field, none at the prompt', async () => {
    const id = await working('Busy while typed into');
    await t.key('ESC');
    await t.pipeline(String(id));
    await t.waitFor(/Busy while typed into/);
    await t.focus('Comment');
    const words =
      'Typed at forty ms while the board moves around me, qzx, and not one key lost or moved.';
    const others = (async () => {
      await sleep(400);
      await w.api('POST', `/api/tasks/${w.ids.ship}/stage`, {
        action: 'claim',
        claimer: 'agent-x',
      });
      await sleep(900);
      await w.domain((c) => c.comments.add(id, 'agent-x', 'From another session'));
      await sleep(900);
      await w.api('POST', `/api/tasks/${id}/stage`, { action: 'advance', by: 'agent-x' });
      await sleep(900);
      await w.domain((c) => c.tasks.addArtifact(id, 'notes', 'Attached meanwhile', 'agent-x'));
    })();
    await typeAt(t, words, 40);
    await others;
    expect(outside(t)).not.toMatch(/qzx/);
    await t.enter();
    await t.waitFor(/comment added/);
    const { comments } = await w.api<{ comments: { content: string; agent_id: string }[] }>(
      'GET',
      `/api/tasks/${id}?include=comments`,
    );
    expect(comments.map((c) => c.content)).toContain(words);
    // What waited while the keys came in is drawn once they stopped.
    await t.waitFor(/▸ notes/, 20_000);
    expect(t.text()).toMatch(/From another session/);
    expect(outside(t)).not.toMatch(/qzx/);
  });
});

describe.skipIf(!E2E)('an artifact with a table in a narrow and a wide dock', () => {
  const TABLE = [
    '| Phase | Owner | Status | Notes |',
    '| --- | --- | --- | --- |',
    '| 1 ledger | alice | done | moved to the new schema of the ledger |',
    '| 2 pane | bob | in review | the dock at sixty columns, then narrower |',
  ].join('\n');
  let w: World;
  beforeAll(async () => {
    w = await startWorld();
    await w.domain((c) =>
      c.tasks.addArtifact(w.ids.pane, 'phases-of-the-implementation-plan', TABLE, 'agent-pane'),
    );
  }, 2 * MIN);
  afterAll(async () => w?.stop(), 2 * MIN);

  for (const [columns, isTable] of [
    [110, false],
    [240, true],
  ] as const)
    it(`${columns} columns: ${isTable ? 'a table' : 'one row a line'}, the name on one line`, async () => {
      const t = new ClaudeTerm(w, columns, 50, FULLSCREEN);
      try {
        await t.start();
        await t.pipeline(String(w.ids.pane));
        await t.waitFor(/Replace the web dashboard/);
        await t.press(/phases-of-the/);
        const s = await t.waitFor(/1 ledger/);
        t.shot(`artifact-table-${columns}`);
        const pane = s.split('\n').map((l) => l.split('│').slice(1).join('│'));
        // The name never splits a word over two lines.
        expect(pane.some((l) => /phases-of-the/.test(l))).toBe(true);
        expect(pane.some((l) => /^\s*(implementation|plan)\b/.test(l))).toBe(false);
        if (isTable) expect(pane.join('\n')).toMatch(/Phase\s+│?\s*Owner/);
        else {
          expect(pane.join('\n')).toMatch(/Phase · Owner · Status · Notes/);
          expect(pane.join('\n')).toMatch(/2 pane · bob · in review/);
        }
      } finally {
        await t.kill();
      }
    });
});
