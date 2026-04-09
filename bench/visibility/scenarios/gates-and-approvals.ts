// =============================================================================
// Scenario D: gates-and-approvals — tests the Approvals feature directly
// =============================================================================
//
// 6-task feature build with explicit review checkpoints. Two tasks are at
// the `review` stage; one HAS an approval comment from a reviewer, the other
// is waiting (no comment). The manager is asked questions about approval
// status: who approved what, what is still pending review, what was the
// reviewer's verdict.
//
// Naive cannot answer because review state lives in comments and metadata,
// not in source code. agent-tasks: queries comments and stage state.

import type { Scenario } from './types.js';

export const gatesAndApprovalsScenario: Scenario = {
  name: 'gates-and-approvals',
  description:
    '6-task workflow with two tasks at the review stage — one approved, one pending. Tests the APPROVALS feature: who reviewed what, what is still waiting on a human verdict.',
  project: 'pricing-rules',
  contextHint:
    'You are a MANAGER overseeing a feature build that uses an explicit ' +
    'review process. Some tasks have advanced to the "review" stage and are ' +
    'waiting for a reviewer comment before they can advance further. Your job ' +
    'is to figure out which tasks are approved, which are still waiting on a ' +
    'reviewer, and what each reviewer said.',
  tasks: [
    {
      index: 0,
      title: 'Spec the pricing rules engine',
      description: 'Decide the pricing rule schema and edge-case behavior.',
      stage: 'done',
      status: 'completed',
      claimer: 'worker-spec',
      result: 'Pricing rules spec finalized and approved',
      artifacts: [
        {
          type: 'general',
          name: 'spec',
          content: `# Pricing rules spec

Each rule has:
- match (predicate over the order)
- adjustment (percent off, fixed off, or override)
- priority (highest priority wins on conflict)

Edge cases: stacking is forbidden; only one rule applies per order.`,
        },
        {
          type: 'comment',
          content: 'Reviewed and approved by alice on 2026-04-05. No revisions requested.',
        },
      ],
    },
    {
      index: 1,
      title: 'Implement RuleEngine class',
      description: 'Translate the spec into the RuleEngine class with priority resolution.',
      stage: 'review',
      status: 'in_progress',
      claimer: 'worker-impl-1',
      artifacts: [
        {
          type: 'comment',
          content:
            'Implementation done, advanced to review. Reviewer: alice. APPROVED on 2026-04-08 with comment "LGTM, priority resolution looks correct, ship it." No changes requested.',
        },
      ],
    },
    {
      index: 2,
      title: 'Implement match predicate parser',
      description: 'Parse user-facing match strings into predicate functions.',
      stage: 'review',
      status: 'in_progress',
      claimer: 'worker-impl-2',
      artifacts: [
        {
          type: 'comment',
          content:
            'Implementation done, advanced to review on 2026-04-08. Reviewer: bob (assigned). STATUS: PENDING — bob has not yet left a verdict comment. Has been waiting for review for ~6 hours.',
        },
      ],
    },
    {
      index: 3,
      title: 'Wire RuleEngine into the checkout endpoint',
      description: 'Plug RuleEngine into the checkout flow.',
      stage: 'backlog',
      status: 'pending',
      dependsOn: [1],
    },
    {
      index: 4,
      title: 'Tests for RuleEngine priority resolution',
      description: 'Cover the priority/conflict edge cases.',
      stage: 'backlog',
      status: 'pending',
      dependsOn: [1],
    },
    {
      index: 5,
      title: 'Tests for match predicate parser',
      description: 'Cover predicate parsing edge cases.',
      stage: 'backlog',
      status: 'pending',
      dependsOn: [2],
    },
  ],
  files: [
    {
      path: 'package.json',
      content: '{\n  "type": "commonjs",\n  "name": "pricing-rules"\n}\n',
    },
    {
      path: 'src/rule-engine.js',
      content: `// RuleEngine class — implementation pending review
class RuleEngine {
  constructor(rules) {
    this.rules = rules.slice().sort((a, b) => b.priority - a.priority);
  }

  apply(order) {
    for (const rule of this.rules) {
      if (rule.match(order)) return rule.adjustment(order);
    }
    return order.subtotal;
  }
}

module.exports = { RuleEngine };
`,
    },
    {
      path: 'src/match-parser.js',
      content: `// Match predicate parser — implementation pending review
function parseMatch(expr) {
  // ... implementation ...
  return (order) => true;
}

module.exports = { parseMatch };
`,
    },
    {
      path: 'README.md',
      content: `# pricing-rules

Pricing rules engine. Currently in mid-build with two implementation tasks
at the review stage. Approval status for each is tracked by the agents
system, not in this repo.
`,
    },
  ],
  questions: [
    {
      id: 1,
      text: 'List ALL tasks currently at the REVIEW stage waiting on approval. For each, say whether it is APPROVED or PENDING.',
      mustIncludeAllGroups: [
        ['ruleengine', 'rule engine', 'task 2', 'task #2'],
        ['approved'],
        ['match', 'parser', 'predicate', 'task 3', 'task #3'],
        ['pending', 'waiting', 'not yet'],
      ],
    },
    {
      id: 2,
      text: 'WHO is the reviewer for the RuleEngine task, and what verdict did they leave? Quote their comment if possible.',
      mustIncludeAllGroups: [['alice'], ['lgtm', 'approved', 'ship it', 'looks correct']],
    },
    {
      id: 3,
      text: 'WHO is assigned to review the match predicate parser task, and have they responded yet?',
      mustIncludeAllGroups: [['bob'], ['no', 'not yet', 'pending', 'waiting', 'has not']],
    },
    {
      id: 4,
      text: 'How long has the match predicate parser task been waiting on bob to review it?',
      mustIncludeAllGroups: [['6', 'six', 'hours', 'hour']],
    },
    {
      id: 5,
      text: 'Could a worker advance the RuleEngine task from REVIEW to the next stage RIGHT NOW? Why or why not?',
      mustIncludeAllGroups: [
        ['yes', 'can', 'allowed', 'approved'],
        ['alice', 'review', 'lgtm', 'comment'],
      ],
    },
    {
      id: 6,
      text: 'Could a worker advance the match predicate parser task from REVIEW to the next stage RIGHT NOW? Why or why not?',
      mustIncludeAllGroups: [
        ['no', 'cannot', "can't", 'not yet', 'blocked'],
        ['bob', 'review', 'pending', 'comment', 'not approved', 'no comment', 'no verdict'],
      ],
    },
    {
      id: 7,
      text: 'Which tasks are BLOCKED waiting on the match predicate parser task to clear review?',
      mustIncludeAllGroups: [['test', 'tests for match', 'task 6', 'task #6', 'parser test']],
    },
    {
      id: 8,
      text: 'Was the original SPEC for the pricing rules engine approved? If yes, by whom?',
      mustIncludeAllGroups: [['yes', 'approved'], ['alice']],
    },
    {
      id: 9,
      text: 'How many DISTINCT human reviewers are involved in this project across all approvals (so far or pending)?',
      mustIncludeAllGroups: [['2', 'two', 'alice', 'bob']],
    },
    {
      id: 10,
      text: 'If you were the manager, what is the SINGLE most important thing you should do RIGHT NOW to unblock the project?',
      mustIncludeAllGroups: [
        ['bob', 'reviewer'],
        ['review', 'approve', 'verdict', 'unblock', 'parser', 'match'],
      ],
    },
  ],
};
