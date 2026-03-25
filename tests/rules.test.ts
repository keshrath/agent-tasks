import { describe, it, expect } from 'vitest';
import { generateRules } from '../src/domain/rules.js';
import { DEFAULT_STAGES } from '../src/domain/tasks.js';

describe('generateRules', () => {
  describe('mdc format', () => {
    it('generates valid MDC frontmatter', () => {
      const result = generateRules('mdc', DEFAULT_STAGES);
      expect(result).toContain('---');
      expect(result).toContain('alwaysApply: true');
      expect(result).toContain('# Pipeline Workflow');
    });

    it('includes pipeline stage flow', () => {
      const result = generateRules('mdc', DEFAULT_STAGES);
      expect(result).toContain('backlog');
      expect(result).toContain('spec');
      expect(result).toContain('done');
    });

    it('excludes cancelled from stage flow', () => {
      const result = generateRules('mdc', DEFAULT_STAGES);
      const flowLine = result.split('\n').find((l) => l.includes('backlog') && l.includes('done'));
      expect(flowLine).toBeDefined();
      expect(flowLine).not.toContain('cancelled');
    });

    it('includes project name when provided', () => {
      const result = generateRules('mdc', DEFAULT_STAGES, 'my-project');
      expect(result).toContain('Project: my-project');
    });

    it('omits project line when not provided', () => {
      const result = generateRules('mdc', DEFAULT_STAGES);
      expect(result).not.toContain('Project:');
    });

    it('lists key MCP tools', () => {
      const result = generateRules('mdc', DEFAULT_STAGES);
      expect(result).toContain('task_create');
      expect(result).toContain('task_claim');
      expect(result).toContain('task_advance');
      expect(result).toContain('task_complete');
      expect(result).toContain('task_comment');
    });
  });

  describe('claude_md format', () => {
    it('generates markdown section header', () => {
      const result = generateRules('claude_md', DEFAULT_STAGES);
      expect(result).toContain('## Pipeline Tasks');
    });

    it('includes stage flow', () => {
      const result = generateRules('claude_md', DEFAULT_STAGES);
      expect(result).toContain('backlog');
      expect(result).toContain('done');
    });

    it('includes project name when provided', () => {
      const result = generateRules('claude_md', DEFAULT_STAGES, 'test-proj');
      expect(result).toContain('test-proj');
    });

    it('lists key tools', () => {
      const result = generateRules('claude_md', DEFAULT_STAGES);
      expect(result).toContain('task_create');
      expect(result).toContain('task_claim');
      expect(result).toContain('task_complete');
    });
  });

  describe('custom stages', () => {
    it('uses custom stage names in output', () => {
      const result = generateRules('mdc', ['todo', 'doing', 'done']);
      expect(result).toContain('todo');
      expect(result).toContain('doing');
      expect(result).toContain('done');
    });
  });
});
