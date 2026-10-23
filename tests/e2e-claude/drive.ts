// =============================================================================
// Drive the /pipeline pane by hand: one scratch world and one Claude Code
// session in a pseudo-terminal, steered over HTTP so every step can be looked
// at as a PNG. For visual work on plugin/; the suite is pane.e2e.test.ts.
//
//   npx tsx tests/e2e-claude/drive.ts [cols] [rows]     (port: DRIVE_PORT, default 47331)
//   FULLSCREEN=1 for the fullscreen layout (the pane docks beside the transcript)
//   curl -s localhost:47331 -d '{"op":"pipeline"}'
//   ops: pipeline {args?} | key {name, times?} | type {text} | press {label}
//        focus {label} | wait {re} | screen | shot {label} | ids | sync | quit
//
// `sync` copies plugin/hooks and plugin/types into the session's plugin copy and
// reloads the plugins. Shots land in SHOTS_DIR as drive-<label>.
// =============================================================================

import { createServer } from 'node:http';
import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ClaudeTerm, SHOTS_DIR, sleep, startWorld } from './harness.js';
import { renderShots } from './render.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const [cols = 120, rows = 50] = process.argv.slice(2).map(Number);

const world = await startWorld();
const t = new ClaudeTerm(
  world,
  cols,
  rows,
  process.env.FULLSCREEN === '1'
    ? { CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1' }
    : {},
);
const ready = t.start();

type Op = {
  op: string;
  args?: string;
  name?: string;
  times?: number;
  text?: string;
  label?: string;
  re?: string;
};

async function run(o: Op): Promise<string> {
  if (o.op !== 'quit') await ready;
  switch (o.op) {
    case 'pipeline':
      await t.pipeline(o.args ?? '');
      await sleep(1_500);
      break;
    case 'key':
      await t.key(o.name ?? 'ENTER', o.times ?? 1);
      break;
    case 'type':
      await t.type(o.text ?? '');
      break;
    case 'press':
      await t.press(o.label ?? '');
      await sleep(800);
      break;
    case 'focus':
      await t.focus(o.label ?? '');
      break;
    case 'wait':
      await t.waitFor(new RegExp(o.re ?? '.'));
      break;
    case 'ids':
      return JSON.stringify(world.ids);
    case 'sync':
      for (const sub of ['hooks', 'types'])
        cpSync(join(ROOT, 'plugin', sub), join(world.pluginDir, sub), { recursive: true });
      // A pty session does not pick up file saves; the command re-reads the folder.
      await t.key('ESC');
      await t.type('/reload-plugins');
      await t.key('ENTER');
      await t.waitFor(/Reloaded:/);
      await t.pipeline();
      await sleep(1_500);
      break;
    case 'shot': {
      const label = `drive-${o.label ?? Date.now()}`;
      t.shot(label);
      const [file] = await renderShots(SHOTS_DIR, [label]);
      return `${file}\n${t.screen()}`;
    }
    case 'quit':
      setTimeout(async () => {
        await t.kill();
        await world.stop();
        process.exit(0);
      }, 100);
      return 'bye';
  }
  return t.screen();
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      res.end(await run(JSON.parse(body || '{"op":"screen"}') as Op));
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err instanceof Error ? err.message : err));
    }
  });
});
server.listen(Number(process.env.DRIVE_PORT ?? 47331), '127.0.0.1');
ready.then(
  () => process.stdout.write('drive: ready\n'),
  (err: unknown) => process.stdout.write(`drive: failed: ${String(err)}\n`),
);
