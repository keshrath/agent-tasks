// =============================================================================
// A task's detail in the /pipeline pane, in the real Claude Code CLI
// (AGENT_TASKS_E2E_CLAUDE=1, `npm run e2e:claude`): what it shows for every
// kind of task, every action by keyboard and by mouse, the words each form
// needs, stage gates, related tasks and the way back, artifacts, comments,
// other sessions changing the task while it is open, and what the pane toasts.
// Every step is checked on the screen, on the REST server's state and on
// where the focus ring lands.
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

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A Button as the focus ring shows it: `[ Label ]`, or the bare label of a plain one. */
const btn = (label: string) => new RegExp(`^(\\[ )?${esc(label)}( \\])?$`);

/** A long artifact: past the 4,000 characters the pane shows. */
const LOG = Array.from(
  { length: 50 },
  (_, i) => `- line ${String(i + 1).padStart(2, '0')}: ${'x'.repeat(92)}`,
).join('\n');

/** The tasks this suite drives, one per flow, seeded next to the shared ones. */
const extra = (c: Ctx) => {
  const t = c.tasks;
  const mk = (title: string, o: Record<string, unknown> = {}, by = 'lead') =>
    t.create({ title, ...o }, by).id;
  const working = (title: string, o: Record<string, unknown> = {}, who = 'agent-x') => {
    const id = mk(title, o);
    t.claim(id, who);
    return id;
  };

  t.setPipelineConfig('tiny', ['todo', 'doing', 'check', 'done']);
  t.setGateConfig('gate-art', { require_artifact: true });
  t.setGateConfig('gate-com', { require_comment: true });

  const assigned = mk('Wire the release notes', { project: 'release', assign_to: 'agent-later' });
  const custom = working('Trim the tiny pipeline', { project: 'tiny' });
  const gatedArt = working('Advance only with an artifact', { project: 'gate-art' });
  const gatedCom = working('Advance only with a comment', { project: 'gate-com' });
  // In review, its last stage before done: Complete is its next step. Moved there past the
  // gate, as an agent that commented long ago would have left it.
  const gatedFinish = working('Finish only with a comment', { project: 'gate-com' });
  c.db.run(`UPDATE tasks SET stage = 'review' WHERE id = ?`, [gatedFinish]);
  const needsWords = working('Needs words to finish', { project: 'forms' });
  for (let i = 0; i < 4; i++) t.advance(needsWords);
  const minds = working('Change of mind', { project: 'forms' });
  t.advance(minds);

  const mouseAdvance = working('Moved on by mouse', { project: 'mouse' });
  const mouseComplete = working('Completed by mouse', { project: 'mouse' });
  const mouseFail = working('Failed by mouse', { project: 'mouse' });
  const autoFailed = working('Failed while its session was idle', { project: 'reopen' });
  t.advance(autoFailed);
  t.fail(autoFailed, 'The session holding this task ended without completing it (agent-x).');
  const mouseCancel = working('Cancelled by mouse', { project: 'mouse' });
  const mouseDelete = mk('Deleted by mouse', { project: 'mouse' });

  const chainA = working('Chain: the blocked end', { project: 'chain' });
  const chainB = working('Chain: what A waits for', { project: 'chain' });
  const chainC = mk('Chain: a part of B', { parent_id: chainB });
  t.addDependency(chainA, chainB);
  const linked = working('Linked, not blocked', { project: 'chain' });
  const linkedTo = working('The task it is linked to', { project: 'chain' });
  t.addDependency(linked, linkedTo, 'related');

  const arts = working('Artifacts in versions', { project: 'docs' });
  t.addArtifact(arts, 'notes', '# Notes v1\n\nfirst draft', 'agent-docs');
  t.addArtifact(arts, 'notes', '# Notes v2\n\nsecond draft', 'agent-docs');
  t.addArtifact(arts, 'notes', '# Notes v3\n\nThe **final** notes.', 'agent-docs');
  t.addArtifact(arts, 'log', LOG, 'agent-ci');

  const chatty = working('A long discussion', { project: 'docs' });
  let first = 0;
  for (let i = 1; i <= 8; i++) {
    const id = c.comments.add(chatty, i % 2 ? 'agent-a' : 'agent-b', `Point number ${i}`).id;
    if (i === 1) first = id;
  }
  c.comments.add(chatty, 'agent-c', 'A reply to the first point', first);

  const raceGone = working('Deleted by another session', { project: 'race' });
  const raceMoved = working('Moved by another session', { project: 'race' });
  const raceWatched = working('Changed while it is watched', { project: 'race' });

  const ownDone = working('Completed from the pane, quietly', { project: 'toast' });
  const extDone = working('Finished by another session', { project: 'toast' });
  const extFailed = working('Failed by another session', { project: 'toast' });
  const extCancelled = working('Cancelled by another session', { project: 'toast' });
  const extReview = working('Reaching review elsewhere', { project: 'toast' });
  for (let i = 0; i < 3; i++) t.advance(extReview);

  return {
    assigned,
    custom,
    gatedArt,
    gatedCom,
    gatedFinish,
    needsWords,
    minds,
    mouseAdvance,
    mouseComplete,
    mouseFail,
    autoFailed,
    mouseCancel,
    mouseDelete,
    chainA,
    chainB,
    chainC,
    linked,
    linkedTo,
    arts,
    chatty,
    raceGone,
    raceMoved,
    raceWatched,
    ownDone,
    extDone,
    extFailed,
    extCancelled,
    extReview,
  };
};

describe.skipIf(!E2E)('a task in the /pipeline pane', () => {
  let w: World;
  let t: ClaudeTerm;
  let m: Record<string, number>;
  /** The pane's first column: clicks and flattened text look from there on. */
  let paneX = 0;

  /** The pane's text, wrapped lines joined: for outcomes that wrap in the docked pane. */
  const flat = () =>
    t
      .text()
      .split('\n')
      .map((l) => l.slice(paneX))
      .join(' ')
      .replace(/[│\s]+/g, ' ');

  async function waitFlat(re: RegExp, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (re.test(flat())) return flat();
      await sleep(250);
    }
    throw new Error(`the pane never said ${re}:\n${t.screen()}`);
  }

  /** `/pipeline <id>` from the prompt; waits for the task's title. */
  async function show(id: number, title: string) {
    await t.key('ESC');
    await t.pipeline(String(id));
    await t.waitFor(new RegExp(`‹ Board[\\s\\S]*#${id} ${esc(title)}`));
  }

  /** Nothing matching `re` shows up for `ms` (the pane polls every 5 s). */
  async function never(re: RegExp, ms: number) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      expect(t.text()).not.toMatch(re);
      await sleep(250);
    }
  }

  beforeAll(async () => {
    w = await startWorld(extra);
    m = w.more;
    t = new ClaudeTerm(w, 160, 50, FULLSCREEN);
    await t.start();
    await t.pipeline();
    await t.waitFor(/Backlog \d+/);
    const header = t
      .text()
      .split('\n')
      .find((l) => /1: Board/.test(l))!;
    paneX = header.indexOf('1: Board');
  }, 3 * MIN);
  afterAll(async () => {
    await t?.kill();
    await w?.stop();
    await renderShots(SHOTS_DIR);
  }, 2 * MIN);

  describe('what the detail shows', () => {
    it('an unclaimed subtask: its parent, who made it, no step to take, the way back', async () => {
      await show(w.ids.detailView, 'Pane: detail view');
      const s = await t.waitFor(/Comments 0/);
      // A subtask takes its parent's project (its priority is seeded 0).
      expect(s).toMatch(/○ unclaimed · agent-tasks\s*$/m);
      expect(s).toMatch(/backlog › spec › plan › implement › test › review › done/);
      expect(s).toMatch(new RegExp(`Part of\\s+● #${w.ids.pane} Replace the web dashboard`));
      expect(s).toMatch(/Created\s+(just now|\d+m ago) by lead/);
      expect(s).toMatch(/Updated\s+(just now|\d+m ago)/);
      expect(s).toMatch(/Unclaimed: it moves on once an agent claims it\./);
      expect(s).toMatch(/Artifacts 0/);
      expect(s).toMatch(/None yet\./);
      // Nothing to move on, finish or fail before an agent has it; it can still be dropped.
      for (const no of [/Advance ›/, /\[ Complete \]/, /\[ Fail \]/, /‹ Send back/])
        expect(s).not.toMatch(no);
      expect(s).toMatch(/\[ Cancel \] \[ Delete \]/);
      await landsOn(t, '‹ Board'); // no next step: the way out
      t.shot('detail-unclaimed');
    });

    it('an assigned task waits for its agent', async () => {
      await show(m.assigned!, 'Wire the release notes');
      const s = await t.waitFor(/Waiting for agent-later to start it\./);
      expect(s).toMatch(/○ pending · agent-later · release/);
      expect(s).not.toMatch(/Unclaimed/);
      expect(s).not.toMatch(/Advance ›/);
      await landsOn(t, '‹ Board');
    });

    it('a project with its own pipeline: the strip and Advance name its stages', async () => {
      await show(m.custom!, 'Trim the tiny pipeline');
      const s = await t.waitFor(/todo › doing › check › done/);
      expect(s).not.toMatch(/backlog ›/);
      await landsOn(t, '‹ Board'); // never on Advance by itself
      await t.press('Advance › check');
      await until(w, m.custom!, (x) => x.stage === 'check');
      await t.waitFor(/moved to check/);
      await landsOn(t, '‹ Board'); // moved on: the way out, not a second Enter on Complete
      await t.waitFor(/\[ Complete \]/);
      for (let i = 0; i < 40 && /Advance ›/.test(t.text()); i++) await sleep(100);
      expect(t.text()).not.toMatch(/Advance ›/);
      t.shot('detail-custom-pipeline');
    });

    it('a completed task: its result, the strip at done, Reopen and Delete left', async () => {
      await show(w.ids.bump, 'Bump agent-common to 1.1.2');
      const s = await t.waitFor(/Result\s+Bumped; loopback bind and request guard in\./);
      expect(s).toMatch(/✓ completed · agent-release · agent-tasks/);
      expect(s).toMatch(/review › done/);
      expect(s).toMatch(/\[ Reopen \] \[ Delete \]/);
      for (const no of [/\[ Cancel \]/, /\[ Complete \]/, /Advance ›/, /Artifacts/])
        expect(s).not.toMatch(no);
      expect(s).toMatch(/Comment: add one/);
      await landsOn(t, '‹ Board');
    });

    it('a failed task opens again with Reopen: unclaimed at the stage it failed in, claimable', async () => {
      await show(m.autoFailed!, 'Failed while its session was idle');
      await t.waitFor(/✗ failed/);
      await t.press(/^\[ Reopen \]$|^Reopen$/);
      const back = await until(w, m.autoFailed!, (x) => x.status === 'pending');
      expect(back).toMatchObject({ stage: 'plan', assigned_to: null, result: null });
      await waitFlat(new RegExp(`✓ #${m.autoFailed} open again in plan, unclaimed`));
      const s = await t.waitFor(/Unclaimed: it moves on once an agent claims it\./);
      expect(s).not.toMatch(/\[ Reopen \]/);
      await landsOn(t, '‹ Board');
      // Who reopened it, and from what, stays with the task.
      await t.waitFor(/reopen/);
    });

    it('a cancelled task: its reason, no stage strip', async () => {
      await show(w.ids.duplicate, 'Duplicate of the dashboard task');
      const s = await t.waitFor(/Reason\s+duplicate of #\d+/);
      expect(s).toMatch(/– cancelled · agent-tasks/);
      expect(s).not.toMatch(/backlog › spec/);
      // Its duplicate link is a link, shown from both ends and never a blocker.
      expect(s).toMatch(new RegExp(`Duplicate\\s+● #${w.ids.pane} Replace`));
      expect(s).not.toMatch(/Waits for/);
    });
  });

  describe('each form wants its words', () => {
    it('Complete, Fail and Cancel refuse to go without them; the form stays', async () => {
      await show(m.needsWords!, 'Needs words to finish');
      await landsOn(t, '‹ Board');
      await t.press(btn('Complete'));
      await landsOn(t, 'Result');
      await t.enter(); // nothing typed
      await t.waitFor(/✗ a result is needed/);
      expect(t.text()).toMatch(/Complete #\d+/);
      await landsOn(t, 'Result');

      await t.press('Never mind');
      await t.press(btn('Fail'));
      await landsOn(t, 'Error');
      await t.press(btn('Fail')); // the form's own button, nothing typed
      await t.waitFor(/✗ what went wrong is needed/);
      expect(t.text()).toMatch(/Mark #\d+ failed/);

      await t.press('Never mind');
      await t.press(btn('Cancel'));
      await landsOn(t, 'Reason');
      await t.type('   ');
      await t.press(btn('Cancel task'));
      await t.waitFor(/✗ a reason is needed/);
      expect(t.text()).toMatch(/Cancel #\d+/);

      const still = await w.task(m.needsWords!);
      expect([still.stage, still.status]).toEqual(['review', 'in_progress']);
      t.shot('form-refused');
      await t.press('Never mind');
    });

    it('Never mind closes each form and puts the ring back on its button', async () => {
      await show(m.minds!, 'Change of mind');
      const forms: [string, RegExp, string, RegExp][] = [
        ['Complete', /Complete #\d+/, 'Result', btn('Complete')],
        ['‹ Send back', /Send #\d+ back to an earlier stage/, 'Why', btn('‹ Send back')],
        ['Cancel', /Cancel #\d+/, 'Reason', btn('Cancel')],
        ['Fail', /Mark #\d+ failed/, 'Error', btn('Fail')],
      ];
      for (const [label, title, field, ring] of forms) {
        await t.press(btn(label));
        await t.waitFor(title);
        // The form's own landing first, the press then starts from it: Send back's is its
        // stage picker (open while it has the ring), the others' their field.
        if (field === 'Why') await t.waitFor(/▴/);
        else await landsOn(t, field);
        await t.press('Never mind');
        await landsOn(t, ring);
        expect(t.text()).not.toMatch(title);
      }
      const still = await w.task(m.minds!);
      expect([still.stage, still.status]).toEqual(['plan', 'in_progress']);
    });

    it('Send back without a note: the stage before is the default, the ring goes to the way out', async () => {
      await show(m.minds!, 'Change of mind');
      await t.press(btn('‹ Send back'));
      await t.waitFor(/Back to\s+spec/);
      await t.press(btn('Send back')); // the form's button, the note left empty
      await until(w, m.minds!, (x) => x.stage === 'spec');
      await t.waitFor(/back to spec/);
      await landsOn(t, '‹ Board');
    });
  });

  describe('stage gates', () => {
    it('an artifact is required: said up front, no Advance or Complete until one is there', async () => {
      await show(m.gatedArt!, 'Advance only with an artifact');
      await waitFlat(/Needs an artifact before it leaves spec: an agent attaches artifacts\./);
      await landsOn(t, '‹ Board');
      // Only an agent can pass it: neither is offered, so nothing is refused after the fact.
      expect(t.text()).not.toMatch(/Advance › plan|\[ Complete \]/);
      expect((await w.task(m.gatedArt!)).stage).toBe('spec');
      t.shot('gate-refused');
      await w.domain((c) => c.tasks.addArtifact(m.gatedArt!, 'spec', 'the spec', 'agent-x'));
      await t.key('r');
      await t.waitFor(/Artifacts 1/);
      expect(t.text()).not.toMatch(/Needs an artifact/);
      await t.press('Advance › plan');
      await until(w, m.gatedArt!, (x) => x.stage === 'plan');
      await t.waitFor(/moved to plan/);
      await landsOn(t, '‹ Board');
    });

    it('a comment is required: the ring stays off the field, so a next /pipeline is no comment', async () => {
      await show(m.gatedCom!, 'Advance only with a comment');
      await waitFlat(/Needs a comment before it leaves spec: add the comment below\./);
      // The ring lands on the way back, never in the comment field (what the person types
      // next, another /pipeline, goes to the prompt, not into the task) nor on Advance.
      await landsOn(t, '‹ Board');
      t.shot('gate-comment');
      await t.pipeline(String(m.gatedArt!));
      await t.waitFor(/Advance only with an artifact/);
      expect(await w.domain((c) => c.comments.list(m.gatedCom!).length)).toBe(0);
      await show(m.gatedCom!, 'Advance only with a comment');
      // The server stays the authority: Advance pressed anyway is refused, says where the
      // comment goes, and the ring stays on Advance: never in the field, even then.
      await t.press('Advance › plan');
      await waitFlat(/✗ #\d+ can't leave spec yet: add the comment below/);
      expect((await w.task(m.gatedCom!)).stage).toBe('spec');
      await landsOn(t, '‹ Board'); // off Advance, and out of the field
      await t.focus('Comment');
      await t.type('Spec reviewed, good to go.');
      await t.enter();
      await t.waitFor(/Comments 1/);
      await t.waitFor(/^(?![\s\S]*Needs a comment)/);
      await t.press('Advance › plan');
      await until(w, m.gatedCom!, (x) => x.stage === 'plan');
      await t.waitFor(/moved to plan/);
    });

    it('Complete refused for want of a comment keeps its form and words; the ring stays on the form', async () => {
      await show(m.gatedFinish!, 'Finish only with a comment');
      await landsOn(t, '‹ Board');
      await t.press(/^(\[ )?Complete( \])?$/);
      await landsOn(t, 'Result');
      await t.type('Shipped the fix');
      await t.enter();
      await waitFlat(/✗ #\d+ can't leave review yet: add the comment below/);
      expect((await w.task(m.gatedFinish!)).status).toBe('in_progress');
      // The form is still there with what was typed (Enter cleared it; it is drawn back), and
      // says what the gate holds for; the ring on its button, not in a field.
      await t.waitFor(/Shipped the fix/);
      await waitFlat(/Needs a comment before it leaves review: add the comment below\./);
      await landsOn(t, 'Never mind'); // the form's safe button, not Complete
      await t.focus('Comment');
      t.shot('gate-complete-refused');
      await t.type('Reviewed and fine.');
      await t.enter();
      await t.waitFor(/Comments 1/);
      await t.press(/^\[ Complete \]$|^Complete$/);
      await until(w, m.gatedFinish!, (x) => x.status === 'completed');
      expect((await w.task(m.gatedFinish!)).result).toBe('Shipped the fix');
    });
  });

  describe('by mouse', () => {
    it('Advance moves on with one click', async () => {
      await show(m.mouseAdvance!, 'Moved on by mouse');
      await t.click('[ Advance › plan ]', paneX);
      await until(w, m.mouseAdvance!, (x) => x.stage === 'plan');
      await t.waitFor(/moved to plan/);
      await landsOn(t, '‹ Board');
    });

    it('Send back: the form opens on a click and its button sends', async () => {
      await t.click('[ ‹ Send back ]', paneX);
      await t.waitFor(/Send #\d+ back to an earlier stage/);
      await t.focus('Why');
      await t.type('clicked back');
      await t.click('[ Send back ]', paneX);
      await until(w, m.mouseAdvance!, (x) => x.stage === 'spec');
      await t.waitFor(/back to spec/);
    });

    it('Complete: typed into the form, sent by its button', async () => {
      await show(m.mouseComplete!, 'Completed by mouse');
      await t.click('[ Complete ]', paneX);
      await t.waitFor(/Complete #\d+/);
      await landsOn(t, 'Result');
      await t.type('done with the mouse');
      await t.click('[ Complete ]', paneX);
      const done = await until(w, m.mouseComplete!, (x) => x.status === 'completed');
      expect(done.result).toBe('done with the mouse');
      await t.waitFor(/Result\s+done with the mouse/);
    });

    it('Fail and Cancel the same way', async () => {
      await show(m.mouseFail!, 'Failed by mouse');
      await t.click('[ Fail ]', paneX);
      await landsOn(t, 'Error');
      await t.type('broke under the mouse');
      await t.click('[ Fail ]', paneX);
      expect((await until(w, m.mouseFail!, (x) => x.status === 'failed')).result).toBe(
        'broke under the mouse',
      );

      await show(m.mouseCancel!, 'Cancelled by mouse');
      await t.click('[ Cancel ]', paneX);
      await landsOn(t, 'Reason');
      await t.type('not needed');
      await t.click('[ Cancel task ]', paneX);
      expect((await until(w, m.mouseCancel!, (x) => x.status === 'cancelled')).result).toMatch(
        /not needed/,
      );
    });

    it('Delete: Keep it keeps it, Delete #N in the box deletes it', async () => {
      await show(m.mouseDelete!, 'Deleted by mouse');
      await t.click('[ Delete ]', paneX);
      await t.waitFor(/There is no undo/);
      await t.click('[ Keep it ]', paneX);
      await t.waitFor(/\[ Cancel \] \[ Delete \]/);
      expect((await w.task(m.mouseDelete!)).title).toBe('Deleted by mouse');
      await t.click('[ Delete ]', paneX);
      await t.waitFor(/There is no undo/);
      await t.click(`[ Delete #${m.mouseDelete} ]`, paneX);
      await t.waitFor(new RegExp(`#${m.mouseDelete} deleted`));
      await expect(w.task(m.mouseDelete!)).rejects.toThrow(/404/);
    });

    it('a related task opens on a click, and ‹ back returns', async () => {
      await show(m.chainA!, 'Chain: the blocked end');
      await t.click(`#${m.chainB} Chain: what A waits for`, paneX);
      await t.waitFor(/‹ Chain: the blocked end/);
      expect(t.text()).toMatch(new RegExp(`#${m.chainB} Chain: what A waits for`));
      await t.click('‹ Chain: the blocked end', paneX);
      await t.waitFor(/Waits for/);
      expect(t.text()).toMatch(new RegExp(`#${m.chainA} Chain: the blocked end`));
    });
  });

  describe('related tasks and the way back', () => {
    it('blocker → its subtask → back, back, back to the board', async () => {
      await show(m.chainA!, 'Chain: the blocked end');
      const a = await t.waitFor(/It moves on once #\d+ is done\./);
      expect(a).toMatch(/! blocked · agent-x · chain/);
      expect(a).not.toMatch(/Advance ›|\[ Complete \]/);
      await landsOn(t, `#${m.chainB} Chain: what A waits for`); // the blocker is the place to go
      await t.enter();
      const b = await t.waitFor(/‹ Chain: the blocked end/);
      expect(b).toMatch(new RegExp(`Blocks\\s+! #${m.chainA} Chain: the blocked end`));
      expect(b).toMatch(/Subtasks 0\/1 done/);
      await landsOn(t, `‹ Chain: the blocked end`); // the way back names the task it goes to
      await t.press(`#${m.chainC} Chain: a part of B`);
      const c = await t.waitFor(/‹ Chain: what A waits for/);
      expect(c).toMatch(new RegExp(`Part of\\s+● #${m.chainB} Chain: what A waits for`));
      await t.press('‹ Chain: what A waits for');
      await t.waitFor(/‹ Chain: the blocked end/);
      await t.press('‹ Chain: the blocked end');
      await t.waitFor(/‹ Board/);
      expect(t.text()).toMatch(new RegExp(`#${m.chainA} Chain: the blocked end`));
      await t.press('‹ Board');
      await t.waitFor(/Backlog \d+/);
      await landsOn(t, `#${m.chainA} Chain`); // back on the row the trail started from
    });

    it('a related link does not block: Advance stays', async () => {
      await show(m.linked!, 'Linked, not blocked');
      const s = await t.waitFor(/Related/);
      expect(s).toMatch(new RegExp(`Related\\s+● #${m.linkedTo} The task it is linked to`));
      expect(s).toMatch(/● in progress · agent-x · chain/);
      expect(s).not.toMatch(/Waits for|It moves on once/);
      expect(s).toMatch(/Advance › plan/);
    });
  });

  describe('artifacts', () => {
    it('the newest version of each, in Markdown; a long one is cut at 4,000 characters', async () => {
      await show(m.arts!, 'Artifacts in versions');
      const s = await t.waitFor(/Artifacts 2/);
      expect(s).toMatch(/▸ notes\s+by agent-docs · (just now|\d+m ago) · in spec · v3/);
      expect(s).toMatch(/▸ log\s+by agent-ci/);
      await t.press('▸ notes');
      const n = await t.waitFor(/Notes v3/);
      expect(n).toMatch(/The final notes\./); // bold drawn, not its asterisks
      expect(n).not.toMatch(/Notes v1|first draft|# Notes/);
      await landsOn(t, '▾ notes');
      await t.enter();
      await t.waitFor(/▸ notes/);

      await t.press('▸ log');
      await t.waitFor(/line 01:/);
      await landsOn(t, '▾ log');
      // Further down than the pane is tall: scroll to its end.
      for (let i = 0; i < 80 && !/more characters not shown/.test(t.text()); i++)
        await t.key('DOWN');
      const cut = await t.waitFor(/… \d+ more characters not shown/);
      const shown = 4_000;
      expect(cut).toContain(`… ${LOG.length - shown} more characters not shown`);
      expect(cut).not.toMatch(/line 50:/);
      t.shot('artifact-cut');
      await t.press('▾ log');
      await t.waitFor(/▸ log/);
    });
  });

  describe('comments', () => {
    it('the latest five, the earlier ones on demand, a reply among them', async () => {
      await show(m.chatty!, 'A long discussion');
      const s = await t.waitFor(/Comments 9/);
      expect(s).toMatch(/▸ 4 more/);
      expect(s).toMatch(/A reply to the first point/);
      expect(s).not.toMatch(/Point number 1\b/);
      await t.press('▸ 4 more');
      const all = await t.waitFor(/Point number 1\b/);
      expect(all).toMatch(/▾ Show less/);
      expect(all).toMatch(/agent-a[^\n]*\n[^\n]*Point number 1\b/);
      await landsOn(t, '▾ Show less');
      await t.enter();
      await t.waitFor(/▸ 4 more/);
      await landsOn(t, '▸ 4 more');
    });

    it('a comment from the pane carries the person’s name', async () => {
      await t.focus('Comment');
      await t.type('Read the whole thread.');
      await t.enter();
      const s = await t.waitFor(/Comments 10/);
      expect(s).toMatch(new RegExp(`${ME} just now[^\\n]*\\n[^\\n]*Read the whole thread\\.`));
      // Sent, the ring leaves the field for the comments' fold: what is typed next is no second
      // comment, and the new one stays in sight.
      await landsOn(t, /▸ \d+ more/);
      t.shot('comments-thread');
    });
  });

  describe('other sessions change the task while it is open', () => {
    it('deleted elsewhere: the pane says so and goes back to the board', async () => {
      await show(m.raceGone!, 'Deleted by another session');
      await w.api('DELETE', `/api/tasks/${m.raceGone}`);
      await t.waitFor(new RegExp(`! #${m.raceGone} was deleted elsewhere`), 20_000);
      await t.waitFor(/Backlog \d+/);
      await landsOn(t, /#\d+ /);
      // Gone from the pane (right of its border); /pipeline N named it in the transcript.
      const pane = t
        .text()
        .split('\n')
        .map((l) => l.split('│').slice(1).join('│'));
      expect(pane.join('\n')).not.toMatch(/Deleted by another session/);
    });

    it('moved on elsewhere: an Advance from before is refused, then the detail catches up', async () => {
      await show(m.raceMoved!, 'Moved by another session');
      await t.focus('Advance › plan');
      await w.api('POST', `/api/tasks/${m.raceMoved}/stage`, { action: 'advance', by: 'agent-x' });
      await t.settle(500, 3_000);
      await t.enter(); // drawn while it was in spec: sent with that stage, refused
      await waitFlat(/! #\d+ moved elsewhere \(now plan\): nothing was done/);
      expect((await w.task(m.raceMoved!)).stage).toBe('plan');
      await landsOn(t, '‹ Board'); // refused: the way back, not the next Advance
      await t.waitFor(/Advance › implement/);
    });

    it('changed elsewhere: comments and stage show up without a key', async () => {
      await show(m.raceWatched!, 'Changed while it is watched');
      await t.waitFor(/Comments 0/);
      await w.api('POST', `/api/tasks/${m.raceWatched}/comments`, {
        content: 'Seen from another session',
        agent_id: 'agent-y',
      });
      await w.api('POST', `/api/tasks/${m.raceWatched}/stage`, {
        action: 'advance',
        by: 'agent-x',
      });
      const s = await t.waitFor(/Seen from another session/, 20_000);
      expect(s).toMatch(/Comments 1/);
      await t.waitFor(/Advance › implement/, 20_000);
      // The Advance the ring was on moved on with the task: the ring goes to the way back,
      // not onto a button that now does something else.
      await landsOn(t, '‹ Board', 15_000);
    });
  });

  describe('toasts and the status entry', () => {
    it('what the pane does itself is not toasted', async () => {
      await show(m.ownDone!, 'Completed from the pane, quietly');
      await t.press(btn('Complete'));
      await landsOn(t, 'Result');
      await t.type('quiet');
      await t.enter();
      await until(w, m.ownDone!, (x) => x.status === 'completed');
      await t.waitFor(new RegExp(`✓ #${m.ownDone} completed`));
      await never(new RegExp(`Done: #${m.ownDone}`), 12_000); // two polls and more
    });

    it('a cancel elsewhere is quiet; a failure and a review elsewhere are toasted', async () => {
      await t.press('‹ Board');
      await t.waitFor(/Backlog \d+/);
      await w.api('POST', `/api/tasks/${m.extCancelled}/stage`, {
        action: 'cancel',
        reason: 'not needed',
        by: 'agent-x',
      });
      await never(new RegExp(`(Done|Failed|for review): #${m.extCancelled}`), 12_000);

      await w.api('POST', `/api/tasks/${m.extFailed}/stage`, {
        action: 'fail',
        result: 'it broke',
        by: 'agent-x',
      });
      await w.api('POST', `/api/tasks/${m.extReview}/stage`, { action: 'advance', by: 'agent-x' });
      expect((await w.task(m.extReview!)).stage).toBe('review');
      await t.waitFor(new RegExp(`Failed: #${m.extFailed} Failed by another session`), 20_000);
      expect(t.text()).toMatch(new RegExp(`for review: #${m.extReview} Reaching review`));
      t.shot('toast-failed-review');
    });

    it('the status entry follows tasks made and finished elsewhere', async () => {
      const count = () => Number(/(\d+) open tasks/.exec(statusEntry(t) ?? '')?.[1]);
      const before = count();
      await w.api('POST', '/api/tasks', { title: 'Made in another session', created_by: 'x' });
      const deadline = Date.now() + 15_000;
      while (count() !== before + 1 && Date.now() < deadline) await sleep(250);
      expect(count()).toBe(before + 1);
      await w.api('POST', `/api/tasks/${m.extDone}/stage`, {
        action: 'complete',
        result: 'shipped',
        by: 'agent-x',
      });
      await t.waitFor(new RegExp(`Done: #${m.extDone} Finished by another`), 20_000);
      const after = Date.now() + 15_000;
      while (count() !== before && Date.now() < after) await sleep(250);
      expect(count()).toBe(before);
      // The board's own summary agrees.
      expect(t.text()).toMatch(new RegExp(`${before} open tasks`));
    });
  });
});
