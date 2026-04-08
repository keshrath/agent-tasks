// =============================================================================
// Visibility bench scenario — frozen mid-feature state.
//
// A single, hand-crafted, deterministic snapshot of an in-flight feature build:
// "Add CSV export to a TODO app." Imagined timeline frozen at minute 8 of an
// imagined 15-minute build with 3 worker agents. The state has the same
// shape in BOTH conditions (file system identical); the difference is what
// the manager has access to: just the file system, or also the agent-tasks DB
// + MCP tools + dashboard.
//
// The scenario is deliberately seeded with two TRAPS that the dashboard makes
// trivial to find but file-system inspection makes hard:
//
//   TRAP 1: Spec-implementation drift. Task 1 spec says "include archived
//           items by default". Task 3's partial impl filters them out.
//   TRAP 2: Stale claim. Task 4 was claimed 5 minutes ago by worker-3 and
//           has produced no output (the file is empty). A manager should
//           notice this idle claim.
// =============================================================================

export interface SeedTask {
  /** Stable ordinal — referenced by `dependsOn` indices. */
  index: number;
  title: string;
  description: string;
  /** Final stage to advance the task to (after claim, after artifacts attached). */
  stage: 'backlog' | 'spec' | 'plan' | 'implement' | 'test' | 'review' | 'done';
  /** Final status. The driver applies status transitions via the appropriate
   * TaskService methods (claim → in_progress, complete → completed). */
  status: 'pending' | 'in_progress' | 'completed';
  /** Worker name that claims the task (only used when status !== 'pending'). */
  claimer?: string;
  /** Indices into the SeedTask list — these tasks must complete before this one. */
  dependsOn?: number[];
  /** Artifacts attached to this task. */
  artifacts?: Array<{
    type: 'general' | 'decision' | 'comment';
    name?: string;
    content?: string;
    chose?: string;
    over?: string;
    because?: string;
  }>;
  /** Result string (only used for completed tasks). */
  result?: string;
}

export const SEED_TASKS: SeedTask[] = [
  {
    index: 0,
    title: 'Spec the CSV export format',
    description:
      'Decide the exact CSV dialect, headers, and edge-case behavior for the export feature.',
    stage: 'done',
    status: 'completed',
    claimer: 'worker-1',
    result: 'Spec finalized: RFC 4180 dialect, headers id/title/status/created_at/archived',
    artifacts: [
      {
        type: 'general',
        name: 'spec',
        content: `# CSV Export Format

**Dialect**: RFC 4180 (commas, double-quote escaping, CRLF newlines).

**Headers** (in order):
- id          (string, the todo id)
- title       (string, the todo title)
- status      (string: "open" | "done")
- created_at  (ISO 8601 timestamp)
- archived    (boolean, "true" or "false")

**Default behavior**: include ALL items, including archived ones. The user explicitly
asked for archived items in the export so they can review historical work in Excel.
A future flag --no-archived can opt out, but the default exports everything.

**Quoting**: only fields containing commas, quotes, CR, or LF need quoting.
**Empty array**: produces a single header line and no data rows.`,
      },
    ],
  },
  {
    index: 1,
    title: 'Choose CSV vs JSON for export format',
    description: 'Decide which serialization format the export feature should use.',
    stage: 'done',
    status: 'completed',
    claimer: 'worker-1',
    result: 'CSV chosen (decision recorded)',
    artifacts: [
      {
        type: 'decision',
        chose: 'CSV (RFC 4180 dialect)',
        over: 'JSON, Excel XLSX, TSV',
        because:
          'User base lives in Excel for analysis. CSV is the simplest format Excel imports without quirks. JSON would require a separate viewer step. XLSX needs a binary library and adds dependencies. TSV is fine but CSV is more universally recognized by spreadsheet tools.',
      },
    ],
  },
  {
    index: 2,
    title: 'Implement exportCsv() in export.js',
    description:
      'Implement the exportCsv(items) function. It MUST follow the spec attached to the "Spec the CSV export format" task — read the spec artifact before coding. Pay close attention to default behavior for archived items.',
    stage: 'implement',
    status: 'in_progress',
    claimer: 'worker-2',
    dependsOn: [0],
    artifacts: [
      {
        type: 'comment',
        content:
          'Started ~3 minutes ago. Wrote header row + first iteration of the row builder. Still need to handle quoting and the archived items default.',
      },
    ],
  },
  {
    index: 3,
    title: 'Implement parseImport() in import.js',
    description:
      'Implement the inverse: parse CSV back into a list of todos. Round-trip must satisfy: parseImport(exportCsv(items)) deep-equals items.',
    stage: 'implement',
    status: 'in_progress',
    claimer: 'worker-3',
    dependsOn: [0],
    artifacts: [
      {
        type: 'comment',
        content:
          'Claimed ~5 minutes ago. I need to read the spec artifact on task #1 before I can start. Have not produced any code yet.',
      },
    ],
  },
  {
    index: 4,
    title: 'Tests for export round-trip',
    description:
      'Test that exportCsv() + parseImport() round-trip preserves all fields including archived items.',
    stage: 'backlog',
    status: 'pending',
    dependsOn: [2, 3],
  },
  {
    index: 5,
    title: 'CLI subcommand: `todo export`',
    description: 'Wire exportCsv() to a `todo export <file>` CLI subcommand.',
    stage: 'backlog',
    status: 'pending',
    dependsOn: [2],
  },
];

// ---------------------------------------------------------------------------
// Frozen file system contents — IDENTICAL across naive and agent-tasks
// conditions. The whole point of the bench is that the visible artifacts on
// disk are the same; only the structured DB differs.
// ---------------------------------------------------------------------------

export interface SeedFile {
  path: string;
  content: string;
}

export const SEED_FILES: SeedFile[] = [
  {
    path: 'package.json',
    content: '{\n  "type": "commonjs",\n  "name": "todo-app"\n}\n',
  },
  {
    path: 'todo.js',
    content: `// In-memory TODO app — pre-existing code.
// Items are { id, title, status, created_at, archived }.

const items = [];

function addItem(title) {
  const item = {
    id: String(items.length + 1),
    title,
    status: 'open',
    created_at: new Date().toISOString(),
    archived: false,
  };
  items.push(item);
  return item;
}

function archive(id) {
  const item = items.find((i) => i.id === id);
  if (item) item.archived = true;
}

function listItems(opts = {}) {
  if (opts.includeArchived) return items;
  return items.filter((i) => !i.archived);
}

module.exports = { addItem, archive, listItems, items };
`,
  },
  {
    // worker-2's WIP — partially implemented exportCsv. Contains TRAP 1:
    // it filters out archived items, contradicting the spec which says
    // "include ALL items, including archived ones".
    path: 'export.js',
    content: `// Worker-2 WIP — exportCsv() in progress.
// TODO: handle quoting for fields containing commas, quotes, CRLF.

const { listItems } = require('./todo.js');

function exportCsv() {
  // TRAP: spec says include archived by default, but this filters them out.
  const items = listItems({ includeArchived: false });
  const header = 'id,title,status,created_at,archived';
  const rows = items.map((i) => {
    return [i.id, i.title, i.status, i.created_at, i.archived].join(',');
  });
  return [header, ...rows].join('\\n');
}

module.exports = { exportCsv };
`,
  },
  {
    // worker-3's empty file — nothing started yet (the manager should
    // detect this idle claim).
    path: 'import.js',
    content: '// Worker-3 placeholder — parseImport() not yet started.\n',
  },
  {
    // README that exists in the repo and gives the manager generic context
    // about the project. This is what naive condition has to grep through.
    path: 'README.md',
    content: `# todo-app

In-memory todo app. Currently being extended with a CSV export feature.

## In flight (as of this snapshot)

3 worker agents are building the CSV export. State of the work is tracked
\`agents\` system. Worker-1 spec'd the format, worker-2 is implementing
\`exportCsv()\`, worker-3 is implementing \`parseImport()\`.

The format spec, the CSV-vs-JSON decision rationale, and the per-worker
status notes are recorded by the agents but the location of the records
depends on which coordination layer you're using.
`,
  },
];

// ---------------------------------------------------------------------------
// The 10 questions and their auto-grading rubrics.
//
// Each question gets a list of "must-include" substring patterns. If the
// answer text (lowercased) contains AT LEAST ONE of the alternatives in
// EVERY group, it scores 1.0. If it contains some but not all groups, it
// scores partial. Otherwise 0.
// ---------------------------------------------------------------------------

export interface Question {
  id: number;
  text: string;
  /** Each inner array is a "must-include-one-of" group. The answer must
   * contain at least one alternative from EVERY group to score 1.0. */
  mustIncludeAllGroups: string[][];
  /** Optional: phrases that, if present, indicate a wrong answer (auto-score 0). */
  mustNotInclude?: string[];
}

export const QUESTIONS: Question[] = [
  {
    id: 1,
    text: 'Which tasks are currently IN PROGRESS, and which worker is on each? Answer with task title + worker name.',
    mustIncludeAllGroups: [
      ['exportcsv', 'export.js', 'task 3', 'task #3', 'task 2', 'task #2'],
      ['worker-2'],
      ['parseimport', 'import.js', 'task 4', 'task #4', 'task 3', 'task #3'],
      ['worker-3'],
    ],
  },
  {
    id: 2,
    text: 'Is anything currently blocked, and if so on what?',
    mustIncludeAllGroups: [
      ['parseimport', 'import.js', 'task 4', 'task #4', 'worker-3', 'task 3', 'task #3'],
      ['spec', 'task 1', 'task #1', 'csv format', 'csv export format'],
    ],
  },
  {
    id: 3,
    text: 'Has the CSV export format spec been finalized? If yes, by whom?',
    mustIncludeAllGroups: [['yes', 'finalized', 'completed', 'done', 'is finalized'], ['worker-1']],
  },
  {
    id: 4,
    text: 'Why was CSV chosen as the export format instead of JSON? Give the recorded rationale.',
    mustIncludeAllGroups: [['excel'], ['json']],
  },
  {
    id: 5,
    text: 'Does the partial implementation in export.js match the format spec for HOW ARCHIVED ITEMS should be handled by default? Answer YES or NO and explain.',
    mustIncludeAllGroups: [
      ['no', "doesn't", 'does not', 'mismatch', 'drift', 'inconsistent', 'contradicts'],
      ['archived'],
    ],
    mustNotInclude: ['matches', 'consistent', 'correct'],
  },
  {
    id: 6,
    text: 'Which IN_PROGRESS task has gone the longest without producing any output (idle the longest)?',
    mustIncludeAllGroups: [['parseimport', 'import.js', 'task 4', 'task #4', 'worker-3']],
  },
  {
    id: 7,
    text: 'If worker-3 just crashed, what task was it on, and what would the next agent need to read FIRST before resuming? Be specific about which artifact or file.',
    mustIncludeAllGroups: [
      ['parseimport', 'import.js', 'task 4', 'task #4'],
      ['spec', 'task 1', 'task #1', 'spec artifact'],
    ],
  },
  {
    id: 8,
    text: 'How many tasks remain (status pending or in_progress) before this CSV export feature can ship?',
    mustIncludeAllGroups: [['4', 'four']],
  },
  {
    id: 9,
    text: 'Which task was DONE most recently, and what is its result/outcome in one sentence?',
    mustIncludeAllGroups: [
      [
        'spec',
        'csv format',
        'csv export format',
        'csv vs json',
        'csv chosen',
        'rfc 4180',
        'task 1',
        'task #1',
        'task 2',
        'task #2',
      ],
    ],
  },
  {
    id: 10,
    text: 'List ALL tasks in the BACKLOG (status pending, not yet started). Give title for each.',
    mustIncludeAllGroups: [
      ['test', 'round-trip', 'tests for export'],
      ['cli', 'subcommand', 'todo export'],
    ],
  },
];
