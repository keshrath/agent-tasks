// =============================================================================
// agent-tasks bench runner — pilot dispatch + results persistence.
//
// `npm run bench:run` runs the mock driver (no API spend, harness sanity check).
// `npm run bench:run -- --real` runs live Claude CLI subagents.
// `--pilot=<name>` runs just one pilot. Currently only `task-claim-race`.
// `--n-runs=N` replicates each condition N times for variance estimation.
//
// Each pilot writes its result to bench/_results/latest.json.
//
// HISTORY: v0.1.0 had three pilots — task-claim-race, dependency-graph,
// cross-session-pipeline. The N=3 heavy bench run revealed dependency-graph
// and cross-session-pipeline had no viable budget window (both produced
// degenerate 0/6 or 1/6 results due to MCP protocol overhead dominating
// the cost of small work units). Both were removed in v1.10.1; see
// bench/README.md "Removed pilots" for the full post-mortem.
// =============================================================================

import * as path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { aggregate, type MultiAgentRun, type BenchReport } from './metrics.js';
import { makeCliDriver } from './drivers/cli.js';

// ---------------------------------------------------------------------------
// Results persistence
// ---------------------------------------------------------------------------

interface PersistedPilot {
  name: string;
  description: string;
  timestamp: string;
  conditions: Array<{ label: string; report: BenchReport }>;
}

interface PersistedResults {
  version: string;
  generated_at: string;
  pilots: PersistedPilot[];
}

const RESULTS_DIR = path.resolve('bench/_results');
const RESULTS_FILE = path.join(RESULTS_DIR, 'latest.json');

function loadResults(): PersistedResults {
  if (!existsSync(RESULTS_FILE)) {
    return { version: '0.2.0', generated_at: new Date().toISOString(), pilots: [] };
  }
  try {
    return JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) as PersistedResults;
  } catch {
    return { version: '0.2.0', generated_at: new Date().toISOString(), pilots: [] };
  }
}

function recordPilot(pilot: PersistedPilot): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const all = loadResults();
  // Drop entries for pilots that no longer exist (cleanup of v0.1.0 results).
  const live = new Set(['task-claim-race']);
  const filtered = all.pilots.filter((p) => p.name !== pilot.name && live.has(p.name));
  filtered.push(pilot);
  filtered.sort((a, b) => a.name.localeCompare(b.name));
  const out: PersistedResults = {
    version: '0.2.0',
    generated_at: new Date().toISOString(),
    pilots: filtered,
  };
  writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2));
}

export interface WorkloadTask {
  task_id: string;
  workload: string;
  target: string;
  prompt: string;
}

export interface AgentDriver {
  runOnce(
    task: WorkloadTask,
    n: number,
    condition: MultiAgentRun['condition'],
  ): Promise<MultiAgentRun>;
}

export interface RunWorkloadOptions {
  workload: string;
  tasks: WorkloadTask[];
  n_agents: number;
  driver: AgentDriver;
  conditions?: MultiAgentRun['condition'][];
  n_runs?: number;
}

export async function runWorkload(opts: RunWorkloadOptions): Promise<BenchReport[]> {
  const conditions = opts.conditions ?? ['control'];
  const nRuns = opts.n_runs ?? 1;
  const reports: BenchReport[] = [];
  for (const condition of conditions) {
    const runs: MultiAgentRun[] = [];
    for (const task of opts.tasks) {
      for (let i = 0; i < nRuns; i++) {
        runs.push(await opts.driver.runOnce(task, opts.n_agents, condition));
      }
    }
    reports.push(aggregate(runs));
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Mock driver — deterministic synthetic data, no API spend.
// ---------------------------------------------------------------------------

export const mockDriver: AgentDriver = {
  async runOnce(task, n, condition) {
    const isCoordinated =
      condition === 'agent-tasks-claim' ||
      condition === 'pipeline-claim' ||
      condition === 'flat-claim' ||
      condition === 'dep-aware';
    const ALL = ['fnA', 'fnB', 'fnC', 'fnD', 'fnE', 'fnF'];
    return {
      run_id: `${task.task_id}-${condition}`,
      workload: task.workload,
      condition,
      total_wall_ms: isCoordinated ? 60000 : 50000,
      merged_tests_passed: isCoordinated,
      agents: Array.from({ length: n }, (_, i) => ({
        agent: `a${i}`,
        files_edited: isCoordinated ? [`${ALL[i % ALL.length]}.js`] : ['shared.js'],
        subgoals: [`implement ${ALL[i % ALL.length]}`],
        tokens: 1500,
        wall_ms: isCoordinated ? 60000 : 50000,
        tests_passed: isCoordinated,
        units_completed:
          i === 0
            ? isCoordinated
              ? [ALL[0], ALL[1], ALL[2], ALL[3], ALL[4]] // 5/6 deduped
              : [ALL[0], ALL[1], ALL[2], ALL[3]] // 4/6 naive
            : [],
        cost_usd: 0.5,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function getNRuns(): number {
  const arg = process.argv.find((a) => a.startsWith('--n-runs='));
  if (!arg) return 1;
  const n = parseInt(arg.split('=')[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function formatReport(r: BenchReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return [
    `  ${r.condition.padEnd(20)} n=${r.n_runs}`,
    `    unique_units           ${r.mean_unique_units.toFixed(1)}`,
    `    wall_seconds           ${r.mean_wall_seconds.toFixed(1)}s`,
    `    total_cost_usd         $${r.mean_total_cost_usd.toFixed(3)}`,
    `    units_per_dollar       ${r.units_per_dollar.toFixed(2)}`,
    `    individual_pass_rate   ${pct(r.individual_pass_rate)}`,
    `    mean_parallelism       ${r.mean_parallelism.toFixed(2)}x`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Pilot 1: task-claim-race
// ---------------------------------------------------------------------------
//
// 3 agents in a shared workspace with 6 TODO functions. Tests whether
// agent-tasks's atomic claim semantics produce a measurable advantage over
// naive parallel agents that coordinate informally via the file system.
//
// N=3 result (v1.10.1): MARGINAL — claim 4.3/6 vs naive 3.7/6, identical
// units/$ (~2.84). The atomic primitive does prevent some collisions but
// the gain on this fixture size doesn't justify the cost. The headline +84%
// units/$ from the original N=1 run was timing noise. See bench/README.md.

async function runTaskClaimRace(): Promise<void> {
  const nRuns = getNRuns();
  const fixtureDir = path.resolve('bench/workloads/task-claim-race');
  const expectedFiles = [
    'csv-parse.js',
    'format-number.js',
    'word-wrap.js',
    'roman.js',
    'lcs.js',
    'email-validate.js',
  ];
  const fileList = expectedFiles.join(', ');

  const naivePromptForAgent = (i: number): string =>
    `You are agent #${i} (of 3) sharing this directory with two other parallel ` +
    `agents. There are 6 TODO functions, each in its own file: ${fileList}. ` +
    `Your goal: implement as many UNIQUE functions as the team can. Pick any 2, ` +
    `implement them, verify with \`node test.js\`. CRITICAL: do NOT duplicate ` +
    `work — if your Edit fails or you see another agent already touched a file, ` +
    `pick a different one. Team is graded on UNIQUE functions completed.`;

  const claimPromptForAgent = (i: number): string =>
    `You are worker #${i} in a parallel team of 3. You are sharing this directory ` +
    `with two other agents working in parallel right now. There are 6 TODO ` +
    `functions, one per file: ${fileList}.\n\n` +
    `Your work queue is the agent-tasks pipeline. Use these MCP tools EXACTLY:\n\n` +
    `LOOP:\n` +
    `  1. mcp__agent-tasks__task_list with project="bench" stage="backlog"\n` +
    `  2. Pick the FIRST task from the list whose status is "pending".\n` +
    `  3. mcp__agent-tasks__task_stage action=claim task_id=<id> claimer=worker-${i}\n` +
    `     If the response is an error or the task is already claimed by someone\n` +
    `     else, go back to step 1 and try a different task.\n` +
    `  4. Implement the TODO function described in the claimed task. Edit ONLY\n` +
    `     the file referenced by that task — never edit a file you have not\n` +
    `     successfully claimed.\n` +
    `  5. Run \`node test.js\` to confirm your function is in PASSED_FNS.\n` +
    `  6. mcp__agent-tasks__task_stage action=complete task_id=<id> result="done"\n` +
    `  7. Go back to step 1.\n\n` +
    `EXIT when task_list returns no pending tasks. ABSOLUTE RULE: never edit a ` +
    `file whose task you have not claimed via step 3.`;

  const task: WorkloadTask = {
    task_id: 'task-claim-race-pilot',
    workload: 'task-claim-race',
    target: fixtureDir,
    prompt: 'unused — see promptForAgent',
  };

  const naive = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.5,
    expectedFiles,
    sharedDir: true,
    promptForAgent: naivePromptForAgent,
  });
  const claim = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.5,
    expectedFiles,
    sharedDir: true,
    promptForAgent: claimPromptForAgent,
  });

  console.log('=== task-claim-race (3 agents, 6 functions, shared dir) ===');
  const naiveR = (
    await runWorkload({
      workload: 'task-claim-race',
      tasks: [task],
      n_agents: 3,
      driver: naive,
      conditions: ['control'],
      n_runs: nRuns,
    })
  )[0];
  console.log(`  --- naive (no MCP) [N=${nRuns}] ---`);
  console.log(formatReport(naiveR));

  const claimR = (
    await runWorkload({
      workload: 'task-claim-race',
      tasks: [task],
      n_agents: 3,
      driver: claim,
      conditions: ['agent-tasks-claim'],
      n_runs: nRuns,
    })
  )[0];
  console.log(
    `  --- agent-tasks-claim (driver pre-creates 6 tasks; agents claim) [N=${nRuns}] ---`,
  );
  console.log(formatReport(claimR));
  console.log();

  recordPilot({
    name: 'task-claim-race',
    description:
      '3 agents in a shared workspace with 6 TODO functions. Tests agent-tasks atomic claim semantics vs naive parallel.',
    timestamp: new Date().toISOString(),
    conditions: [
      { label: 'naive', report: naiveR },
      { label: 'agent-tasks-claim', report: claimR },
    ],
  });
}

// ---------------------------------------------------------------------------
// Pilot 2: dependency-graph (RESTORED in v1.10.2 — see README post-mortem)
// ---------------------------------------------------------------------------
//
// 6 files in a real DAG (b,c require a; d requires b,c; e,f independent).
// Conditions: naive, flat-claim (6 tasks no edges), dep-aware (+addDependency).
//
// Status: INCONCLUSIVE on this fixture size. v1.10.1 N=3 with $0.25 budget
// found all MCP-based conditions floored at 0/6 due to protocol overhead.
// Kept for future re-runs with larger work units, where the dep-edge
// feature has a fair chance of producing signal.

async function runDependencyGraph(): Promise<void> {
  const nRuns = getNRuns();
  const budget = 0.5;
  const fixtureDir = path.resolve('bench/workloads/dependency-graph');
  const expectedFiles = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'];
  const taskDescriptions = [
    'Implement a.js: replace the body so it exports `{ x: 1 }`. No dependencies.',
    'Implement b.js: it requires a.js. Replace the body so it exports `a.x + 2` (which is 3). Do NOT start until a.js is done — if you do, require("./a.js") returns null and your test will fail.',
    'Implement c.js: it requires a.js. Replace the body so it exports `a.x * 5` (which is 5). Do NOT start until a.js is done.',
    'Implement d.js: it requires b.js AND c.js. Replace the body so it exports `b + c` (which is 8). Do NOT start until both b.js and c.js are done.',
    'Implement e.js: independent of all other files. Replace the body so it exports the string "hello".',
    'Implement f.js: independent of all other files. Replace the body so it exports the number 42.',
  ];
  const dependencyEdges: Array<[number, number]> = [
    [1, 0],
    [2, 0],
    [3, 1],
    [3, 2],
  ];
  const fileList = expectedFiles.join(', ');

  const naivePrompt = (i: number): string =>
    `You are agent #${i} (of 3) sharing this directory with two parallel agents. ` +
    `There are 6 TODO files: ${fileList}. They have a dependency structure ` +
    `(b and c require a; d requires b and c; e and f are independent). ` +
    `Read each file. Pick any 2 to implement, verify with \`node test.js\`. ` +
    `Don't duplicate work. Team is graded on files passing.`;

  const flatClaimPrompt = (i: number): string =>
    `You are worker #${i}. Loop:\n` +
    `  1. mcp__agent-tasks__task_list project="bench" stage="backlog"\n` +
    `  2. Pick a pending task and call task_stage action=claim claimer=worker-${i}\n` +
    `  3. Implement the file the task names. Verify with node test.js.\n` +
    `  4. task_stage action=complete result="done"\n` +
    `  5. Loop until task_list is empty. Never edit unclaimed files.`;

  const depAwarePrompt = (i: number): string =>
    `You are worker #${i}. The pipeline has a dependency graph. Loop:\n` +
    `  1. mcp__agent-tasks__task_list next=true agent=worker-${i}\n` +
    `     (returns highest-priority unblocked task; respects deps)\n` +
    `  2. If nothing returned, EXIT — done.\n` +
    `  3. task_stage action=claim task_id=<id> claimer=worker-${i}\n` +
    `  4. Implement the file using the task description as your spec.\n` +
    `  5. Run node test.js to verify.\n` +
    `  6. task_stage action=complete task_id=<id> result="done"\n` +
    `  7. Loop. Never edit unclaimed files.`;

  const task: WorkloadTask = {
    task_id: 'dependency-graph-pilot',
    workload: 'dependency-graph',
    target: fixtureDir,
    prompt: 'unused',
  };

  const naive = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: budget,
    expectedFiles,
    sharedDir: true,
    promptForAgent: naivePrompt,
  });
  const flat = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: budget,
    expectedFiles,
    sharedDir: true,
    taskDescriptions,
    promptForAgent: flatClaimPrompt,
  });
  const depAware = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: budget,
    expectedFiles,
    sharedDir: true,
    taskDescriptions,
    dependencyEdges,
    promptForAgent: depAwarePrompt,
  });

  console.log(`=== dependency-graph (3 agents, 6 files, real DAG, $${budget}/agent) ===`);
  const naiveR = (
    await runWorkload({
      workload: 'dependency-graph',
      tasks: [task],
      n_agents: 3,
      driver: naive,
      conditions: ['control'],
      n_runs: nRuns,
    })
  )[0];
  console.log(`  --- naive (no MCP) [N=${nRuns}] ---`);
  console.log(formatReport(naiveR));

  const flatR = (
    await runWorkload({
      workload: 'dependency-graph',
      tasks: [task],
      n_agents: 3,
      driver: flat,
      conditions: ['flat-claim'],
      n_runs: nRuns,
    })
  )[0];
  console.log(`  --- flat-claim (6 tasks, NO dep edges) [N=${nRuns}] ---`);
  console.log(formatReport(flatR));

  const depR = (
    await runWorkload({
      workload: 'dependency-graph',
      tasks: [task],
      n_agents: 3,
      driver: depAware,
      conditions: ['dep-aware'],
      n_runs: nRuns,
    })
  )[0];
  console.log(`  --- dep-aware (6 tasks + addDependency edges) [N=${nRuns}] ---`);
  console.log(formatReport(depR));
  console.log();

  recordPilot({
    name: 'dependency-graph',
    description:
      '3 agents, 6 TODO files with a real DAG (b,c require a; d requires b,c; e,f independent). Tests whether agent-tasks dependency edges measurably win over a flat queue. INCONCLUSIVE on this fixture size — see README.',
    timestamp: new Date().toISOString(),
    conditions: [
      { label: 'naive', report: naiveR },
      { label: 'flat-claim', report: flatR },
      { label: 'dep-aware', report: depR },
    ],
  });
}

// ---------------------------------------------------------------------------
// Pilot 3: cross-session-pipeline (RESTORED in v1.10.2)
// ---------------------------------------------------------------------------
//
// 2 agents in SEQUENCE. Tight per-agent budget so neither can solo. Tests
// whether structured task state survives the process boundary so agent B
// can resume agent A.
//
// Status: INCONCLUSIVE on this fixture size. v1.10.1 N=3 found agent-tasks
// 6.4× WORSE than naive at $0.30/agent because MCP overhead consumed the
// budget. Kept for future re-runs with larger work units.

async function runCrossSessionPipeline(): Promise<void> {
  const nRuns = getNRuns();
  const fixtureDir = path.resolve('bench/workloads/task-claim-race');
  const expectedFiles = [
    'csv-parse.js',
    'format-number.js',
    'word-wrap.js',
    'roman.js',
    'lcs.js',
    'email-validate.js',
  ];
  const fileList = expectedFiles.join(', ');

  const naivePrompt = (i: number): string =>
    `You are agent #${i} in a sequential 2-agent team. There are 6 TODO functions ` +
    `in this directory: ${fileList}. Only one agent runs at a time. Implement as ` +
    `many TODO functions as your budget allows, then exit. If files already have ` +
    `implementations from the previous agent, LEAVE THEM ALONE. Use \`node test.js\` ` +
    `to see which files still need work (PASSED_FNS=...). Team is graded on UNIQUE ` +
    `functions completed across both agents.`;

  const claimPrompt = (i: number): string =>
    `You are worker #${i} in a sequential 2-worker team. Only one runs at a time.\n\n` +
    `LOOP:\n` +
    `  1. mcp__agent-tasks__task_list next=true agent=worker-${i}\n` +
    `     (returns highest-priority unassigned task with deps met; ignores stage)\n` +
    `  2. If nothing returned: mcp__agent-tasks__task_list project="bench" status="pending"\n` +
    `     (catches tasks left assigned by a crashed worker)\n` +
    `  3. If both empty, EXIT — all work done.\n` +
    `  4. mcp__agent-tasks__task_stage action=claim task_id=<id> claimer=worker-${i}\n` +
    `  5. Implement the file the task names. Run node test.js.\n` +
    `  6. mcp__agent-tasks__task_stage action=complete task_id=<id> result="done"\n` +
    `  7. Loop. When budget runs low, exit — next worker picks up via the DB.`;

  const task: WorkloadTask = {
    task_id: 'cross-session-pipeline-pilot',
    workload: 'cross-session-pipeline',
    target: fixtureDir,
    prompt: 'unused',
  };

  const naive = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.3,
    expectedFiles,
    sharedDir: true,
    sequentialAgents: true,
    promptForAgent: naivePrompt,
  });
  const claim = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.3,
    expectedFiles,
    sharedDir: true,
    sequentialAgents: true,
    promptForAgent: claimPrompt,
  });

  console.log('=== cross-session-pipeline (2 sequential agents, $0.30 each) ===');
  const naiveR = (
    await runWorkload({
      workload: 'cross-session-pipeline',
      tasks: [task],
      n_agents: 2,
      driver: naive,
      conditions: ['control'],
      n_runs: nRuns,
    })
  )[0];
  console.log(`  --- naive (sequential, no MCP) [N=${nRuns}] ---`);
  console.log(formatReport(naiveR));

  const claimR = (
    await runWorkload({
      workload: 'cross-session-pipeline',
      tasks: [task],
      n_agents: 2,
      driver: claim,
      conditions: ['agent-tasks-claim'],
      n_runs: nRuns,
    })
  )[0];
  console.log(`  --- agent-tasks-claim (sequential, shared DB) [N=${nRuns}] ---`);
  console.log(formatReport(claimR));
  console.log();

  recordPilot({
    name: 'cross-session-pipeline',
    description:
      '2 agents in SEQUENCE sharing the agent-tasks SQLite DB. Tight per-agent budget so neither can solo. INCONCLUSIVE on this fixture size — protocol overhead dominates at the budget required to force handoff. See README.',
    timestamp: new Date().toISOString(),
    conditions: [
      { label: 'naive', report: naiveR },
      { label: 'agent-tasks-claim', report: claimR },
    ],
  });
}

// ---------------------------------------------------------------------------
// Pilot 4: realistic-funcs (NEW in v1.10.2 — large-workload bench)
// ---------------------------------------------------------------------------
//
// 4 NON-TRIVIAL functions to implement (parseCsv, stringifyCsv, diffObjects,
// renderTemplate). Each is ~80-150 LOC of real code with detailed test
// assertions. Per-task work cost should be $0.30-1.00, so the ~$0.15 MCP
// protocol overhead is amortized to <30% of work cost.
//
// Hypothesis: at this work-unit size, the atomic claim primitive's
// collision-prevention savings should EXCEED the MCP protocol overhead, and
// agent-tasks should win on units/$ for the first time in this bench.

async function runRealisticFuncs(): Promise<void> {
  const nRuns = getNRuns();
  const fixtureDir = path.resolve('bench/workloads/realistic-funcs');
  // Use file names for unit attribution. The test prints PASSED_FNS for the
  // four FUNCTIONS, not file names — so we override expectedFiles to match
  // what the test reports. The driver pre-creates 4 tasks each describing
  // ONE function in detail.
  const expectedFiles = ['parseCsv', 'stringifyCsv', 'diffObjects', 'renderTemplate'];
  const taskDescriptions = [
    'Implement parseCsv(text, opts?) in csv.js. Read the file header comment for the FULL spec. Required behaviors: parse first non-empty line as header (or use opts.header), handle quoted fields with embedded commas/quotes (double-quote escape), tolerate CRLF and trailing newlines, empty fields → "", opts.skipEmptyLines default true. Returns array of objects keyed by header. Do NOT modify the stringifyCsv function — that is a separate task. Run `node test.js` and confirm parseCsv appears in PASSED_FNS.',
    'Implement stringifyCsv(rows, opts?) in csv.js. Read the file header comment for the FULL spec. Required: header row is union of keys from first row in insertion order then any new keys appended; quote any field containing comma/quote/CR/LF; escape embedded quotes by doubling; \\n row terminator; missing fields → empty string. Do NOT modify the parseCsv function — that is a separate task. Run `node test.js` and confirm stringifyCsv appears in PASSED_FNS.',
    'Implement diffObjects(a, b) in diff.js. Read the file header comment for the FULL spec. Top-level only (do not recurse), returns {added, removed, changed: {key: {from, to}}, unchanged: string[]}. NaN === NaN via Object.is. unchanged sorted alphabetically. Run `node test.js` and confirm diffObjects appears in PASSED_FNS.',
    'Implement renderTemplate(tpl, vars) in template.js. Read the file header comment for the FULL spec. {{name}} interpolation with whitespace tolerance, missing var → "", \\{{ escapes literal {{, filter syntax with chaining (| upper | trim | lower | length | default(\'x\')), unknown filter throws. Run `node test.js` and confirm renderTemplate appears in PASSED_FNS.',
  ];

  const fnList = expectedFiles.join(', ');

  const naivePrompt = (i: number): string =>
    `You are agent #${i} (of 3) sharing this directory with two other parallel ` +
    `agents. There are 4 NON-TRIVIAL functions to implement across 3 files ` +
    `(csv.js: parseCsv + stringifyCsv; diff.js: diffObjects; template.js: ` +
    `renderTemplate). Each function has a detailed spec in its file's header ` +
    `comment — READ IT FIRST before writing any code.\n\n` +
    `Your goal: implement as many UNIQUE functions as the team can. Pick any ` +
    `1-2 functions, implement them carefully (each is 50-150 LOC), and verify ` +
    `with \`node test.js\`. The team is graded on UNIQUE functions in ` +
    `PASSED_FNS. CRITICAL: do NOT duplicate work — if your Edit fails because ` +
    `another agent touched a function, pick a different one. Functions you ` +
    `MUST cover collectively: ${fnList}.`;

  const claimPrompt = (i: number): string =>
    `You are worker #${i} in a parallel team of 3. There are 4 NON-TRIVIAL ` +
    `functions to implement; each task in your queue describes ONE function ` +
    `with the full spec.\n\n` +
    `LOOP:\n` +
    `  1. mcp__agent-tasks__task_list project="bench" status="pending"\n` +
    `  2. Pick the FIRST pending task. Read its description carefully — it ` +
    `contains the spec.\n` +
    `  3. mcp__agent-tasks__task_stage action=claim task_id=<id> claimer=worker-${i}\n` +
    `     If claim fails (already taken), go back to step 1.\n` +
    `  4. Implement the function the task names. Each function is 50-150 LOC ` +
    `of real code. Read the file's header comment for additional spec detail. ` +
    `DO NOT touch other functions in the same file — they are owned by other tasks.\n` +
    `  5. Run \`node test.js\` and confirm your function name is in PASSED_FNS.\n` +
    `  6. mcp__agent-tasks__task_stage action=complete task_id=<id> result="done"\n` +
    `  7. Go back to step 1. EXIT when no pending tasks remain.\n\n` +
    `ABSOLUTE RULE: never modify a function whose task you have not claimed.`;

  const task: WorkloadTask = {
    task_id: 'realistic-funcs-pilot',
    workload: 'realistic-funcs',
    target: fixtureDir,
    prompt: 'unused',
  };

  // Larger budget — these tasks are real implementation work. ~$1 per
  // function = ~$1-2 per agent. Per-agent cap of $1.50 lets each agent
  // attempt 1-2 functions but not solo the whole workload, so coordination
  // matters.
  const naive = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 1.5,
    expectedFiles,
    sharedDir: true,
    promptForAgent: naivePrompt,
  });
  const claim = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 1.5,
    expectedFiles,
    sharedDir: true,
    taskDescriptions,
    promptForAgent: claimPrompt,
  });

  console.log('=== realistic-funcs (3 agents, 4 non-trivial functions, $1.50/agent) ===');
  const naiveR = (
    await runWorkload({
      workload: 'realistic-funcs',
      tasks: [task],
      n_agents: 3,
      driver: naive,
      conditions: ['control'],
      n_runs: nRuns,
    })
  )[0];
  console.log(`  --- naive (no MCP) [N=${nRuns}] ---`);
  console.log(formatReport(naiveR));

  const claimR = (
    await runWorkload({
      workload: 'realistic-funcs',
      tasks: [task],
      n_agents: 3,
      driver: claim,
      conditions: ['agent-tasks-claim'],
      n_runs: nRuns,
    })
  )[0];
  console.log(`  --- agent-tasks-claim (driver pre-creates 4 spec'd tasks) [N=${nRuns}] ---`);
  console.log(formatReport(claimR));
  console.log();

  recordPilot({
    name: 'realistic-funcs',
    description:
      '3 agents in a shared dir with 4 non-trivial functions (parseCsv, stringifyCsv, diffObjects, renderTemplate). Each function is 50-150 LOC of real implementation work, tested by detailed assertions. Per-task work cost is large enough to amortize MCP protocol overhead.',
    timestamp: new Date().toISOString(),
    conditions: [
      { label: 'naive', report: naiveR },
      { label: 'agent-tasks-claim', report: claimR },
    ],
  });
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const real = process.argv.includes('--real');

  if (!real) {
    const tasks: WorkloadTask[] = [
      { task_id: 'mock-1', workload: 'mock', target: 'fixture', prompt: 'do the thing' },
    ];
    console.log('agent-tasks bench (mock driver) — pilot: task-claim-race\n');
    for (const condition of ['control', 'agent-tasks-claim'] as const) {
      const reports = await runWorkload({
        workload: 'mock',
        tasks,
        n_agents: 3,
        driver: mockDriver,
        conditions: [condition],
      });
      for (const r of reports) console.log(formatReport(r), '\n');
    }
    console.log('Pass --real to run live Claude Code subagents.');
    return;
  }

  const pilotArg = process.argv.find((a) => a.startsWith('--pilot='))?.split('=')[1];
  const runAll = !pilotArg || pilotArg === 'all';
  if (runAll || pilotArg === 'task-claim-race') await runTaskClaimRace();
  if (runAll || pilotArg === 'dependency-graph') await runDependencyGraph();
  if (runAll || pilotArg === 'cross-session-pipeline') await runCrossSessionPipeline();
  if (runAll || pilotArg === 'realistic-funcs') await runRealisticFuncs();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
