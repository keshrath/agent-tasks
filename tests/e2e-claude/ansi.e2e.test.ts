// =============================================================================
// Tasks as agents write them from tool output, in the real Claude Code CLI:
// colour codes, title escapes and stray control characters in a description,
// a result, a comment and an artifact (the domain refuses them in titles, names
// and tags). The pane draws them without the escapes; it never goes blank, and
// its hotkeys stay its own.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClaudeTerm, startWorld, type World } from './harness.js';

const E2E = process.env.AGENT_TASKS_E2E_CLAUDE === '1';
const MIN = 60_000;
// The real CLI: typing /pipeline, a poll, a drawing take seconds; vitest's 10 s is for unit tests.
vi.setConfig({ testTimeout: 2 * MIN });
const FULLSCREEN = { CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1' };
const NOISY =
  '\u001b[31mred\u001b[0m \u001b]0;title\u0007tests\u001b[1m pass\u001b[22m\r\nnext\u0008line';

describe.skipIf(!E2E)('/pipeline with control characters in what agents wrote', () => {
  let w: World;
  let t: ClaudeTerm;
  let id = 0;
  beforeAll(async () => {
    w = await startWorld((c) => {
      const task = c.tasks.create(
        { title: 'Colourful output', description: `Ran it:\n${NOISY}`, project: 'ansi' },
        'lead',
      );
      c.tasks.claim(task.id, 'agent-ansi');
      c.comments.add(task.id, 'agent-ansi', `log ${NOISY}`);
      c.tasks.addArtifact(task.id, 'output', `# Output\n${NOISY}`, 'agent-ansi');
      const done = c.tasks.create({ title: 'Finished in colour', project: 'ansi' }, 'lead');
      c.tasks.claim(done.id, 'agent-ansi');
      c.tasks.complete(done.id, `built: ${NOISY}`);
      return { ansi: task.id, done: done.id };
    });
    id = w.more.ansi!;
    t = new ClaudeTerm(w, 160, 50, FULLSCREEN);
    await t.start();
  }, 2 * MIN);
  afterAll(async () => {
    await t?.kill();
    await w?.stop();
  }, 2 * MIN);

  it('Done draws a result without its escapes, and the pane keeps its keys', async () => {
    await t.pipeline();
    await t.waitFor(/Backlog \d+/);
    await t.key('2');
    await t.waitFor(/built: red tests pass/);
    // The hotkeys are the pane's: 1 goes back to the board, nothing reaches the prompt.
    await t.key('1');
    await t.waitFor(/Backlog \d+/);
    expect(t.text()).toMatch(/^❯\s*$/m);
  });

  it('a task draws its description, comment and artifact without their escapes', async () => {
    await t.key('ESC');
    await t.pipeline(String(id));
    const s = await t.waitFor(/Ran it:/);
    expect(s).toMatch(/log red/);
    await t.press(/▸ output/);
    await t.waitFor(/# Output|Output/);
    expect(t.text()).toMatch(/next.line/);
    expect(t.text()).toMatch(/1: Board\s+2: Done/);
  });
});
