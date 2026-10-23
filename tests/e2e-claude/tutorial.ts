// =============================================================================
// Records the /pipeline tutorial: one scripted session in the real Claude Code
// CLI (fullscreen layout, the pane docked beside the conversation) against a
// scratch world, filmed as a captioned WebM plus one PNG per step.
//
//   npx tsx tests/e2e-claude/tutorial.ts           record and render -> ~/.claude/tmp/pane-shots-tasks/tutorial/
//   npx tsx tests/e2e-claude/tutorial.ts --render  render the last recording again
//   ... --docs                                     also copy the stills docs/TUTORIAL.md shows to docs/images/tutorial/
//
// Slash commands and the pane make no model calls; a run costs no tokens.
// =============================================================================

import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ClaudeTerm, SHOTS_DIR, sleep, startWorld } from './harness.js';
import { renderShots, renderVideo, type Caption, type Frame } from './render.js';

const OUT = join(SHOTS_DIR, '..', 'tutorial');
const DOCS = resolve(import.meta.dirname, '..', '..', 'docs', 'images', 'tutorial');
const COLS = 150;
const ROWS = 42;

type Step = { label: string; text: string };
type Recording = { frames: Frame[]; captions: Caption[]; steps: Step[] };

/** The scripted session: each step captions what comes, plays it, and keeps a still. */
async function record(): Promise<Recording> {
  const world = await startWorld();
  const { ids } = world;
  // Full repaints: without them the headless terminal keeps stale cells beside the pane.
  const t = new ClaudeTerm(world, COLS, ROWS, {
    CLAUDE_CODE_NO_FLICKER: '1',
    CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1',
  });
  await t.start();
  const rec: Recording = { frames: [], captions: [], steps: [] };
  const t0 = Date.now();
  const recorder = setInterval(() => {
    const data = t.serialize();
    if (rec.frames.at(-1)?.data !== data) rec.frames.push({ at: Date.now() - t0, data });
  }, 80);

  const step = async (label: string, text: string, act: () => Promise<void>, hold = 2_500) => {
    rec.captions.push({ at: Date.now() - t0, text });
    await act();
    await sleep(hold);
    rec.steps.push({ label, text });
    writeFileSync(
      join(OUT, `${String(rec.steps.length).padStart(2, '0')}-${label}.ansi`),
      JSON.stringify({ cols: COLS, rows: ROWS, data: t.serialize() }),
    );
  };
  // Typed like a person, so the video shows it.
  const typeSlowly = async (text: string, ms = 60) => {
    for (const ch of text) {
      await t.type(ch);
      await sleep(ms);
    }
  };
  const command = async (args: string) => {
    await t.key('ESC');
    await typeSlowly(`/pipeline${args ? ` ${args}` : ''}`);
    await sleep(400);
    await t.key('ENTER');
    // Keys sent while the command still runs are queued for the prompt.
    await sleep(500);
    while (/esc to interrupt/.test(t.text())) await sleep(100);
    await sleep(300);
  };

  try {
    await step('start', 'Claude Code with the agent-tasks plugin', async () => {}, 1_500);
    await step(
      'open',
      'Type /pipeline and press Enter: the board opens beside the conversation',
      async () => {
        await command('');
        await t.waitFor(/Backlog \d+/);
      },
      3_500,
    );
    await step(
      'detail',
      'Tab moves the focus, Enter opens a task: its stage, facts, description and more',
      async () => {
        await t.focus(`#${ids.pane} Replace`);
        await sleep(700);
        await t.enter();
        await t.waitFor(/Acceptance:/);
      },
      3_500,
    );
    await step(
      'artifact',
      'Artifacts agents attached unfold as Markdown',
      async () => {
        await t.focus('▸ spec');
        await sleep(500);
        await t.enter();
        await t.waitFor(/▾ spec/);
        await t.key('DOWN', 8); // ↑↓ scroll the pane
        await t.waitFor(/Detail with actions/);
      },
      3_000,
    );
    await step(
      'comment',
      'Leave a comment for the agents working on it',
      async () => {
        await t.focus('Comment');
        await sleep(400);
        await typeSlowly('Docked at 60 columns looks right.');
        await t.enter();
        await t.waitFor(/Comments 3/);
      },
      3_000,
    );
    await step(
      'advance',
      '/pipeline 12 opens a task directly; the focus is on its next step',
      async () => {
        await command(String(ids.changelog));
        await t.waitFor(/Write the CHANGELOG 2\.0\.0 entry/);
      },
      3_000,
    );
    await step(
      'advanced',
      'Enter on Advance moves it to the next stage',
      async () => {
        await t.enter();
        await t.waitFor(/moved to plan/);
      },
      3_000,
    );
    await step(
      'send-back',
      '‹ Send back asks for the stage and why',
      async () => {
        await t.focus('‹ Send back');
        await sleep(400);
        await t.enter();
        await t.waitFor(/Send #\d+ back/);
        await typeSlowly('The spec misses the migration notes');
      },
      3_000,
    );
    await step(
      'sent-back',
      'Enter sends it back, with the reason kept',
      async () => {
        await t.enter();
        await t.waitFor(/back to spec/);
      },
      2_500,
    );
    await step(
      'complete',
      'In its last stage, Complete asks for the result',
      async () => {
        await command(String(ids.serverJson));
        await t.waitFor(/Bump server\.json to 2\.0\.0/);
        await t.focus('Complete');
        await sleep(600);
        await t.enter();
        await t.waitFor(/Complete #\d+/);
        await typeSlowly('server.json is on 2.0.0 in both places');
      },
      3_000,
    );
    await step(
      'completed',
      'Done: the result is on the task',
      async () => {
        await t.enter();
        await t.waitFor(/✓ completed/);
      },
      2_500,
    );
    await step(
      'blocked',
      'A blocked task cannot move on: it points at what it waits for',
      async () => {
        await command(String(ids.harness));
        await t.waitFor(/Waits for/);
      },
      3_500,
    );
    await step(
      'done',
      'The 2 key: recently finished tasks, each with its result',
      async () => {
        await t.key('2');
        await t.waitFor(/Recently finished/);
      },
      3_000,
    );
    await step(
      'new',
      'The 3 key: a new task. Enter walks the fields and creates it on the last',
      async () => {
        await t.key('3');
        await t.waitFor(/New task/);
        await t.settle();
        for (const [i, v] of [
          'Record the /pipeline tutorial',
          'docs',
          '4',
          'docs, ui',
          'From the real CLI',
        ].entries()) {
          await typeSlowly(v, 40);
          if (i < 4) await t.enter();
        }
      },
      2_500,
    );
    await step(
      'created',
      'It lands in backlog, and its detail opens',
      async () => {
        await t.enter();
        await t.waitFor(/created #\d+/);
      },
      3_000,
    );
    await step(
      'find',
      'Back on the board, Find narrows it to what matches',
      async () => {
        await t.focus('‹ Board');
        await t.enter();
        await t.waitFor(/Backlog \d+/);
        await t.focus('Find');
        await typeSlowly('agent-tasks');
        await t.enter();
        await t.waitFor(/\d+ shown/);
      },
      3_500,
    );
    await step(
      'esc',
      'Esc hands the keyboard back to the prompt; ctrl+x tab takes it again',
      async () => {
        await t.focus(/#\d+ /);
        await t.key('ESC');
        await t.waitFor(/ctrl\+x tab to work this pane/);
      },
      3_000,
    );
  } finally {
    clearInterval(recorder);
    await t.kill();
    await world.stop();
  }
  return rec;
}

if (!process.argv.includes('--render')) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'recording.json'), JSON.stringify(await record()));
}
const rec = JSON.parse(readFileSync(join(OUT, 'recording.json'), 'utf8')) as Recording;
const pngs = await renderShots(OUT);
const video = await renderVideo(
  join(OUT, 'pipeline-tutorial.webm'),
  { cols: COLS, rows: ROWS },
  rec.frames,
  rec.captions,
);
writeFileSync(join(OUT, 'steps.json'), JSON.stringify(rec.steps, null, 2));
if (process.argv.includes('--docs')) {
  mkdirSync(DOCS, { recursive: true });
  // The stills docs/TUTORIAL.md shows.
  const shown = readFileSync(join(DOCS, '..', '..', 'TUTORIAL.md'), 'utf8');
  for (const f of readdirSync(OUT).filter((x) => x.endsWith('.png') && shown.includes(x)))
    copyFileSync(join(OUT, f), join(DOCS, f));
}
const seconds = Math.round((rec.frames.at(-1)?.at ?? 0) / 1000);
process.stdout.write(
  `${video}\n${pngs.length} stills, ${rec.frames.length} frames, ${seconds} s\n`,
);
process.exit(0); // a pty or browser handle can outlive the run
