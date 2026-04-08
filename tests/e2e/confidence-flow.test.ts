// =============================================================================
// E2E: confidence gate + per-stage instructions, end-to-end pipeline run
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../../src/context.js';
import { createTestContext } from '../helpers.js';

let ctx: AppContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

describe('E2E: confidence + stage_instructions full pipeline', () => {
  it('blocks a vague task, then accepts an improved version and surfaces stage instructions', () => {
    // Project author defines a strict gate plus per-stage guidance.
    ctx.tasks.setGateConfig('webapp', {
      min_confidence_for_claim: 50,
      stage_instructions: {
        spec: 'Write the acceptance criteria as a checklist before advancing.',
        plan: 'List the files you intend to touch and any new dependencies.',
        implement: 'Keep diffs small; write tests alongside the code.',
        test: 'Run npm test and attach the output as an artifact.',
        review: 'Self-review the diff; address any TODOs before completing.',
      },
    });

    // 1. Vague task — should be blocked at claim time.
    const vague = ctx.tasks.create(
      { title: 'fix bug', description: 'broken', project: 'webapp' },
      'human',
    );
    expect(() => ctx.tasks.claim(vague.id, 'agent-1')).toThrow(/confidence/i);

    // 2. Author improves the same task and re-tries.
    ctx.tasks.update(vague.id, {
      title: 'Fix login redirect after OAuth callback',
      description: [
        '# Context',
        'After Google OAuth callback the user lands on /login instead of /dashboard.',
        '',
        '## Steps',
        '- Inspect src/auth/callback.ts',
        '- Restore the post-login redirect target',
        '- Add a regression test',
        '',
        '## Acceptance criteria',
        '- After a successful OAuth callback the user must arrive at /dashboard',
        '- Existing email/password flow should not regress',
      ].join('\n'),
    });

    const claimed = ctx.tasks.claim(vague.id, 'agent-1');
    expect(claimed.assigned_to).toBe('agent-1');
    expect(claimed.stage).toBe('spec');

    // 3. Stage instructions are accessible at every stage as we walk the
    //    pipeline forward.
    const expected: Record<string, string> = {
      spec: 'Write the acceptance criteria as a checklist before advancing.',
      plan: 'List the files you intend to touch and any new dependencies.',
      implement: 'Keep diffs small; write tests alongside the code.',
      test: 'Run npm test and attach the output as an artifact.',
      review: 'Self-review the diff; address any TODOs before completing.',
    };

    let cur = claimed;
    for (const stage of ['spec', 'plan', 'implement', 'test', 'review'] as const) {
      expect(cur.stage).toBe(stage);
      expect(ctx.tasks.getStageInstructions('webapp', cur.stage)).toBe(expected[stage]);
      if (stage !== 'review') {
        cur = ctx.tasks.advance(cur.id);
      }
    }

    // 4. Complete the task — confidence gate only fires at claim time, so
    //    the rest of the workflow is unaffected.
    const done = ctx.tasks.complete(cur.id, 'Redirect restored, regression test added.');
    expect(done.status).toBe('completed');
    expect(done.stage).toBe('done');
  });

  it('confidence gate is per-project — other projects are unaffected', () => {
    ctx.tasks.setGateConfig('strict', { min_confidence_for_claim: 90 });

    const otherProj = ctx.tasks.create({ title: 'fix', project: 'lax' }, 'human');
    expect(() => ctx.tasks.claim(otherProj.id, 'agent-1')).not.toThrow();

    const noProj = ctx.tasks.create({ title: 'fix' }, 'human');
    expect(() => ctx.tasks.claim(noProj.id, 'agent-1')).not.toThrow();

    const strictProj = ctx.tasks.create({ title: 'fix', project: 'strict' }, 'human');
    expect(() => ctx.tasks.claim(strictProj.id, 'agent-1')).toThrow(/confidence/i);
  });
});
