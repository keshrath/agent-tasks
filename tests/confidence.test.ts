// =============================================================================
// Confidence scoring — unit tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import { scoreTaskConfidence } from '../src/domain/confidence.js';

describe('scoreTaskConfidence', () => {
  it('gives a tiny score to a one-word title with no description', () => {
    const { score, reasons } = scoreTaskConfidence({ title: 'fix' });
    expect(score).toBeLessThanOrEqual(15);
    expect(reasons.some((r) => r.includes('Title has only'))).toBe(true);
    expect(reasons.some((r) => r.includes('Description is empty'))).toBe(true);
  });

  it('gives a moderate score to a multi-word title with a short description', () => {
    const { score } = scoreTaskConfidence({
      title: 'Fix login redirect bug',
      description: 'Users are bounced to /login after a successful POST.',
    });
    expect(score).toBeGreaterThanOrEqual(25);
    expect(score).toBeLessThan(70);
  });

  it('rewards a rich description with structure, file refs, and acceptance language', () => {
    const { score } = scoreTaskConfidence({
      title: 'Add confidence gate to claim flow',
      description: [
        '# Goal',
        '',
        'Block claims on tasks with low confidence scores.',
        '',
        '## Steps',
        '- Add `scoreTaskConfidence` in `src/domain/confidence.ts`',
        '- Wire into `claim()` in src/domain/tasks.ts:367',
        '- Surface in mcp-handlers.ts',
        '',
        '## Acceptance criteria',
        '- A task with score < threshold should be rejected at claim time',
        '- Existing tasks with no project gate must continue to work',
        '',
        'See https://example.com/spec for more.',
        '',
        '```ts',
        'expect(score).toBeGreaterThan(0);',
        '```',
      ].join('\n'),
    });
    expect(score).toBeGreaterThanOrEqual(90);
  });

  it('caps the score at 100', () => {
    const massive = 'word '.repeat(500);
    const { score } = scoreTaskConfidence({
      title: 'A reasonably descriptive title here',
      description: `# H\n## H2\n- bullet src/foo.ts\n- bullet two\nshould must expected acceptance criteria done when\nhttps://x.io \`code\` \`\`\`ts\nx\n\`\`\`\n${massive}`,
    });
    expect(score).toBeLessThanOrEqual(100);
  });

  it('handles null/undefined description gracefully', () => {
    expect(() => scoreTaskConfidence({ title: 'x', description: null })).not.toThrow();
    expect(() => scoreTaskConfidence({ title: 'x', description: undefined })).not.toThrow();
  });

  it('explains why a sparse task scored low', () => {
    const { reasons } = scoreTaskConfidence({
      title: 'Fix the thing',
      description: 'It is broken.',
    });
    // At least one actionable reason should be returned.
    expect(reasons.length).toBeGreaterThan(0);
  });
});
