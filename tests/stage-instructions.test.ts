// =============================================================================
// Per-stage instructions + confidence gate — integration tests
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../src/context.js';
import { createTestContext } from './helpers.js';

let ctx: AppContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

describe('GateConfig.stage_instructions', () => {
  it('returns null when nothing is configured', () => {
    expect(ctx.tasks.getStageInstructions('proj-x', 'spec')).toBeNull();
    expect(ctx.tasks.getStageInstructions(null, 'spec')).toBeNull();
  });

  it('returns the configured string for a stage', () => {
    ctx.tasks.setGateConfig('proj-a', {
      stage_instructions: {
        spec: 'Write acceptance criteria as a checklist.',
        review: 'Verify tests run cleanly before approving.',
      },
    });
    expect(ctx.tasks.getStageInstructions('proj-a', 'spec')).toBe(
      'Write acceptance criteria as a checklist.',
    );
    expect(ctx.tasks.getStageInstructions('proj-a', 'review')).toBe(
      'Verify tests run cleanly before approving.',
    );
    expect(ctx.tasks.getStageInstructions('proj-a', 'plan')).toBeNull();
  });

  it('does not leak instructions between projects', () => {
    ctx.tasks.setGateConfig('proj-a', {
      stage_instructions: { spec: 'A-spec' },
    });
    ctx.tasks.setGateConfig('proj-b', {
      stage_instructions: { spec: 'B-spec' },
    });
    expect(ctx.tasks.getStageInstructions('proj-a', 'spec')).toBe('A-spec');
    expect(ctx.tasks.getStageInstructions('proj-b', 'spec')).toBe('B-spec');
  });
});

describe('GateConfig.min_confidence_for_claim', () => {
  it('allows claim when no threshold is configured (backward compat)', () => {
    const t = ctx.tasks.create({ title: 'fix', project: 'p' }, 'agent-1');
    expect(() => ctx.tasks.claim(t.id, 'agent-1')).not.toThrow();
  });

  it('allows claim when threshold is set but task scores high enough', () => {
    ctx.tasks.setGateConfig('p', { min_confidence_for_claim: 30 });
    const t = ctx.tasks.create(
      {
        title: 'Implement OAuth login flow',
        description:
          'Add Google + GitHub OAuth to the login page (src/auth/login.ts). Acceptance: existing email/password login still works; new buttons appear; tokens are persisted.',
        project: 'p',
      },
      'agent-1',
    );
    expect(() => ctx.tasks.claim(t.id, 'agent-1')).not.toThrow();
  });

  it('rejects claim when task confidence is below threshold', () => {
    ctx.tasks.setGateConfig('p', { min_confidence_for_claim: 60 });
    const t = ctx.tasks.create({ title: 'fix', project: 'p' }, 'agent-1');
    expect(() => ctx.tasks.claim(t.id, 'agent-1')).toThrow(/confidence/i);
  });

  it('error message includes the score and at least one reason', () => {
    ctx.tasks.setGateConfig('p', { min_confidence_for_claim: 80 });
    const t = ctx.tasks.create(
      { title: 'do thing', description: 'maybe later', project: 'p' },
      'agent-1',
    );
    let caught: Error | null = null;
    try {
      ctx.tasks.claim(t.id, 'agent-1');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/\/100/);
    expect(caught!.message).toMatch(/Issues:/);
  });

  it('does not affect tasks without a project (no gate to read)', () => {
    const t = ctx.tasks.create({ title: 'fix' }, 'agent-1');
    expect(() => ctx.tasks.claim(t.id, 'agent-1')).not.toThrow();
  });

  it('scoreConfidence() exposes the same scoring on an existing task', () => {
    const t = ctx.tasks.create(
      {
        title: 'Implement OAuth login flow',
        description: '## Goal\n- step 1 src/foo.ts\n- step 2\n\nAcceptance: should work.',
      },
      'agent-1',
    );
    const { score, reasons } = ctx.tasks.scoreConfidence(t.id);
    expect(score).toBeGreaterThan(50);
    expect(Array.isArray(reasons)).toBe(true);
  });
});
