// =============================================================================
// Scenario type definitions for the visibility bench
// =============================================================================

export interface SeedTask {
  index: number;
  title: string;
  description: string;
  stage: 'backlog' | 'spec' | 'plan' | 'implement' | 'test' | 'review' | 'done';
  status: 'pending' | 'in_progress' | 'completed';
  claimer?: string;
  dependsOn?: number[];
  artifacts?: Array<{
    type: 'general' | 'decision' | 'comment';
    name?: string;
    content?: string;
    chose?: string;
    over?: string;
    because?: string;
  }>;
  result?: string;
}

export interface SeedFile {
  path: string;
  content: string;
}

export interface Question {
  id: number;
  text: string;
  /** Each inner array is a "must-include-one-of" group. The answer must
   * contain at least one alternative from EVERY group to score 1.0. */
  mustIncludeAllGroups: string[][];
  mustNotInclude?: string[];
}

export interface Scenario {
  /** Stable identifier — used in --scenario flag. */
  name: string;
  /** Human-readable description for the bench output. */
  description: string;
  /** Project name used in the agent-tasks DB (passed to task_list filter). */
  project: string;
  /** Manager preamble override — describes the scenario context. */
  contextHint: string;
  tasks: SeedTask[];
  files: SeedFile[];
  questions: Question[];
}
