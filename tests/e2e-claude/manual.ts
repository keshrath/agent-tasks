// =============================================================================
// Records the pictures of docs/USER-MANUAL.md §4: scripted sessions in the real
// Claude Code CLI against a scratch world (the e2e suite's seeded board), each
// still a PNG and each flow a short GIF in docs/images/manual/.
//
//   npm run manual:record            record everything
//   npm run manual:record -- open    write only the pictures whose name contains "open"
//
// Slash commands and the pane make no model calls; a run costs no tokens. The
// seed is the same each run, so the pictures only change when the pane does.
// =============================================================================

import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClaudeTerm, RECORDING, sleep, startWorld, type World } from './harness.js';
import { Film, Recorder, capture, paneCrop, type Crop, type Take } from './record.js';

const OUT = resolve(import.meta.dirname, '..', '..', 'docs', 'images', 'manual');
const DIST = resolve(import.meta.dirname, '..', '..', 'dist');
const FULLSCREEN = { CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1' };
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

type Shot = { name: string; take: Take; kind: 'png' | 'gif' };

/** A session on the world with helpers that keep stills and clips. */
class Session {
  readonly shots: Shot[] = [];
  readonly t: ClaudeTerm;

  constructor(
    readonly w: World,
    cols: number,
    rows: number,
    env: Record<string, string> = FULLSCREEN,
  ) {
    this.t = new ClaudeTerm(w, cols, rows, env);
  }

  private crop(where: 'pane' | 'full'): Crop | null {
    return where === 'pane' ? paneCrop(this.t) : null;
  }

  /** The screen as it is now. */
  async still(name: string, where: 'pane' | 'full' = 'pane'): Promise<void> {
    await this.t.settle(800, 5_000);
    const frames = [{ at: 0, data: capture(this.t) }];
    this.shots.push({
      name,
      kind: 'png',
      take: { cols: this.t.cols, rows: this.t.rows, frames, crop: this.crop(where) },
    });
  }

  /** Plays `act` while recording it. The crop is taken at the end, with the pane there. */
  async clip(name: string, where: 'pane' | 'full', act: () => Promise<void>): Promise<void> {
    await this.t.settle(800, 5_000);
    const rec = new Recorder(this.t);
    rec.start();
    await sleep(700);
    await act();
    await this.t.settle(500, 4_000);
    const frames = await rec.stop(900);
    this.shots.push({
      name,
      kind: 'gif',
      take: { cols: this.t.cols, rows: this.t.rows, frames, crop: this.crop(where) },
    });
  }

  /** Types like a person, so a clip shows it. */
  async typeSlowly(text: string, ms = 70): Promise<void> {
    for (const ch of text) await this.t.type(ch, ms);
    await sleep(250);
  }

  /**
   * Moves the ring like a person would: one Tab (or shift+Tab) at a time until it holds
   * `label`, then a beat so the clip shows it. Far away, the harness's own focus finishes.
   */
  async tabTo(label: string | RegExp, back = false, max = 14): Promise<void> {
    // A Button with styled children draws its ring in pieces: join them.
    const ring = () => {
      const line = this.t
        .screen()
        .split('\n')
        .find((l) => l.includes('«'));
      return line ? [...line.matchAll(/«([^»]*)»/g)].map((m) => m[1]).join('') : this.t.focused();
    };
    const hit = () => {
      const f = ring();
      return f !== null && (typeof label === 'string' ? f.includes(label) : label.test(f));
    };
    await this.t.settle(400, 3_000);
    for (let i = 0; i < max && !hit(); i++) {
      const before = ring();
      await this.t.key(back ? 'SHIFTTAB' : 'TAB');
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline && ring() === before) await sleep(50);
      await sleep(120);
    }
    if (!hit()) throw new Error(`the ring never reached ${label}:\n${this.t.screen()}`);
    await sleep(450);
  }

  /** `/pipeline [args]` from the prompt, typed visibly. */
  async command(args = ''): Promise<void> {
    await this.t.key('ESC');
    await sleep(250);
    await this.typeSlowly(`/pipeline${args ? ` ${args}` : ''}`, 40);
    await this.t.key('ENTER');
    await sleep(500);
    while (/esc to interrupt/.test(this.t.text())) await sleep(100);
    await sleep(300);
  }
}

/**
 * The world's stage gate: agent-knowledge asks for a comment before a task moves on, and its
 * flaky-sync task is being worked on. Set in the database, then the server restarts so its
 * cached pipeline config is read again.
 */
async function gateWorld(w: World): Promise<void> {
  const { createContext } = (await import(pathToFileURL(join(DIST, 'context.js')).href)) as {
    createContext(o: { path: string }): {
      tasks: {
        setGateConfig(project: string, g: Record<string, unknown>): unknown;
        claim(id: number, by: string): unknown;
      };
      close(): void;
    };
  };
  const c = createContext({ path: join(w.dir, 'tasks.db') });
  try {
    c.tasks.setGateConfig('agent-knowledge', { require_comment: true });
    c.tasks.claim(w.ids.flaky, 'agent-sync');
  } finally {
    c.close();
  }
  await w.stopServer();
  await w.startServer();
}

/** The README's picture: a fresh session opens the board and a task in it. */
async function hero(w: World): Promise<Shot[]> {
  const s = new Session(w, 140, 42);
  const { t } = s;
  await t.start();
  try {
    await s.clip('hero', 'full', async () => {
      await s.command();
      await t.waitFor(/Backlog \d+/);
      await sleep(1_500);
      await s.tabTo(`#${w.ids.pane} Replace`);
      await t.enter();
      await t.waitFor(/Acceptance:/);
      await sleep(1_500);
    });
    return s.shots;
  } finally {
    await t.kill();
  }
}

/** The docked pane, wide: everything but the other layouts and the server going away. */
async function docked(w: World): Promise<Shot[]> {
  const s = new Session(w, 140, 42);
  const { t } = s;
  const { ids } = w;
  const pane = `#${ids.pane} Replace`;
  await t.start();
  try {
    await s.clip('open', 'full', async () => {
      await s.command();
      await t.waitFor(/Backlog \d+/);
      await sleep(1_500);
    });
    await s.still('board-full', 'full');
    await s.still('board');

    await s.clip('navigate', 'pane', async () => {
      await s.tabTo(pane);
      await t.enter();
      await t.waitFor(/Acceptance:/);
      await sleep(1_000);
      await t.key('DOWN', 5);
      await sleep(700);
      await t.key('UP', 5); // the ring stayed on ‹ Board, where the task opened
      await sleep(500);
      await s.tabTo('‹ Board', true);
      await t.enter();
      await t.waitFor(/Backlog \d+/);
      await sleep(300);
    });

    await t.press(pane);
    await t.waitFor(/Acceptance:/);
    await s.still('detail');
    await t.key('ESC');
    await sleep(400);
    await s.still('esc');
    await t.key('FOCUS');
    await sleep(400);

    // The detail's lower half: subtasks, an artifact unfolded, the comments.
    await t.press('▸ spec');
    await t.waitFor(/▾ spec/);
    await t.key('DOWN', 10);
    await s.still('artifact');
    await t.press('▾ spec');
    await t.waitFor(/▸ spec/);

    await s.clip('comment', 'pane', async () => {
      await s.tabTo('Comment');
      await s.typeSlowly('Docked at 60 columns looks right.');
      await t.enter();
      await t.waitFor(/Comments 3/);
    });
    await s.still('comments');

    await s.command(String(ids.changelog));
    await t.waitFor(/Write the CHANGELOG 2\.0\.0 entry/);
    await s.clip('advance', 'pane', async () => {
      await s.tabTo('Advance › plan');
      await t.enter();
      await t.waitFor(/moved to plan/);
    });
    await s.clip('send-back', 'pane', async () => {
      await s.tabTo('‹ Send back');
      await t.enter();
      await t.waitFor(/Send #\d+ back/);
      await t.waitFor(/▴/); // it opens on its stage picker: Enter takes spec, then Why
      await sleep(600);
      await t.enter();
      await sleep(600);
      await s.typeSlowly('The spec misses the migration notes');
      await s.still('form-send-back');
      await t.enter();
      await t.waitFor(/back to spec/);
    });

    await s.command(String(ids.serverJson));
    await t.waitFor(/Bump server\.json to 2\.0\.0/);
    await s.clip('complete', 'pane', async () => {
      await s.tabTo('Complete');
      await t.enter();
      await t.waitFor(/Complete #\d+/);
      await sleep(300);
      await s.typeSlowly('On 2.0.0 in both places');
      await t.enter();
      await t.waitFor(/✓ #\d+ completed/);
    });
    await s.still('completed');

    await s.command(String(ids.wsTests));
    await t.waitFor(/Port the WebSocket tests/);
    await t.press('Fail');
    await t.waitFor(/Mark #\d+ failed/);
    await s.still('form-fail');
    await t.press('Never mind');
    await t.press('Cancel');
    await t.waitFor(/Cancel #\d+/);
    await s.still('form-cancel');
    await t.press('Never mind');

    await s.command(String(ids.restyle));
    await t.waitFor(/Restyle the kanban columns/);
    await s.still('unclaimed');
    await s.clip('delete', 'pane', async () => {
      await s.tabTo('Delete');
      await t.enter();
      await t.waitFor(/Delete #\d+ with its/);
      await sleep(1_400); // the ring starts on Keep it
      await s.tabTo('Delete #');
      await t.enter();
      await t.waitFor(/deleted/);
    });
    await s.command(String(ids.darkMode));
    await t.waitFor(/Dark-mode toggle/);
    await t.press('Delete');
    await t.waitFor(/Delete #\d+ with its/);
    await s.still('confirm-delete');
    await t.press('Keep it');

    await s.command(String(ids.harness));
    await t.waitFor(/Waits for/);
    await s.still('blocked');
    await s.clip('blocked', 'pane', async () => {
      await sleep(900); // the ring starts on what it waits for
      await t.enter();
      await t.waitFor(/Acceptance:/);
      await sleep(1_200);
      await s.tabTo('‹ Write the e2e harness', true);
      await t.enter();
      await t.waitFor(/Waits for/);
    });

    await s.command(String(ids.flaky));
    await t.waitFor(/Investigate flaky knowledge sync/);
    await t.waitFor(/Needs a comment before it leaves/);
    await s.still('gate');

    await t.key('2');
    await t.waitFor(/Recently finished/);
    await s.still('done');

    await s.clip('create', 'pane', async () => {
      await t.key('3');
      await t.waitFor(/New task/);
      await t.key('3'); // the tab pressed again: to type
      await sleep(600);
      for (const [i, v] of [
        'Record the manual',
        'docs',
        '4',
        'docs',
        'GIFs from the CLI',
      ].entries()) {
        await s.typeSlowly(v, 40);
        if (i < 4) await t.key('TAB');
      }
      await t.enter();
      await t.waitFor(/created #\d+/);
    });
    await t.key('3');
    await t.waitFor(/New task/);
    await t.key('3');
    await t.settle();
    await t.type('Tidy the release notes');
    await s.still('new-task');
    await t.press('Clear');
    await t.focus('Create'); // a digit typed in a field goes into it
    await t.key('1');
    await t.waitFor(/Backlog \d+/);

    await s.clip('filter', 'pane', async () => {
      await s.tabTo('Find', true);
      await s.typeSlowly('release');
      await t.enter();
      await t.waitFor(/\d+ shown/);
      await sleep(1_500);
      await s.tabTo('Clear the filter', true);
      await t.enter();
      await t.waitFor(/Backlog \d+/);
    });
    await t.focus('Find');
    await t.type('release');
    await t.enter();
    await t.waitFor(/\d+ shown/);
    await s.still('find');
    await t.press('Clear the filter');

    // Another session's reviewer finishes a review: a toast, and the status entry follows.
    await w.api('POST', `/api/tasks/${ids.review}/stage`, {
      action: 'complete',
      result: 'LGTM',
      by: 'reviewer-1',
    });
    await t.waitFor(/Done: #\d+ Review the REST changes/, 20_000);
    await s.still('toast', 'full');
    return s.shots;
  } finally {
    await t.kill();
  }
}

/** The narrow dock and the inline layout. */
async function layouts(w: World): Promise<Shot[]> {
  const narrow = new Session(w, 110, 40);
  await narrow.t.start();
  try {
    await narrow.command();
    await narrow.t.waitFor(/Backlog \d+/);
    await narrow.still('narrow', 'full');
  } finally {
    await narrow.t.kill();
  }
  const inline = new Session(w, 110, 44, {});
  await inline.t.start();
  try {
    await inline.command();
    await inline.t.waitFor(/Backlog \d+/);
    await inline.still('inline', 'full');
  } finally {
    await inline.t.kill();
  }
  return [...narrow.shots, ...inline.shots];
}

/** The REST server goes away and comes back. */
async function down(w: World): Promise<Shot[]> {
  const s = new Session(w, 120, 36);
  const { t } = s;
  await t.start();
  try {
    await s.command();
    await t.waitFor(/Backlog \d+/);
    await s.clip('server-down', 'pane', async () => {
      await w.stopServer();
      await sleep(400);
      await t.key('r');
      await t.waitFor(/not reachable/);
      await sleep(1_500);
      await t.enter();
      await t.waitFor(/still nothing answers/);
      await sleep(1_200);
      await w.startServer();
      await t.enter();
      await t.waitFor(/Backlog \d+/);
    });
    await w.stopServer();
    await t.key('r');
    await t.waitFor(/not reachable/);
    await s.still('server-down');
    await w.startServer();
    return s.shots;
  } finally {
    await t.kill();
  }
}

const world = await startWorld(undefined, RECORDING);
const shots: Shot[] = [];
try {
  await gateWorld(world);
  shots.push(
    ...(await hero(world)),
    ...(await docked(world)),
    ...(await layouts(world)),
    ...(await down(world)),
  );
} finally {
  await world.stop();
}

if (!only.length) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const film = await Film.open();
try {
  for (const { name, kind, take } of shots) {
    if (only.length && !only.some((o) => name.includes(o))) continue;
    const file = join(OUT, `${name}.${kind}`);
    const bytes = kind === 'png' ? await film.still(file, take) : await film.gif(file, take);
    const size = `${(bytes / 1024).toFixed(0)} KB`;
    const over = bytes > 1_500_000 ? '  ! over 1.5 MB' : '';
    process.stdout.write(`${name}.${kind}  ${size}${over}\n`);
  }
} finally {
  await film.close();
}
process.exit(0); // a pty or browser handle can outlive the run
