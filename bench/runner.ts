// =============================================================================
// agent-tasks throughput bench runner
// =============================================================================
//
// Tests whether agent-tasks's atomic claim primitive measurably wins on
// parallel implementation throughput when work units are large enough to
// amortize the MCP protocol overhead.
//
// `npm run bench:run` runs the mock driver (no API spend, harness sanity).
// `npm run bench:run -- --real` runs live Claude CLI subagents.
// `--n-runs=N` replicates each condition N times for variance estimation.
//
// Only one pilot ships in this bench: `realistic-funcs`. Three earlier
// fixture-class pilots (task-claim-race, dependency-graph,
// cross-session-pipeline) were dropped in v1.10.1 because their fixtures
// were too small to fairly test the features they claimed to measure —
// the per-task MCP protocol overhead consumed the entire per-agent budget
// before workers could produce useful output. realistic-funcs uses 50-150
// LOC tasks (~$0.30-0.60 each of work) so the overhead is amortized.
//
// For the visibility / management dimension of agent-tasks (the actual
// product claim from the LinkedIn post), see bench/visibility/.

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
    return { version: '1.0.0', generated_at: new Date().toISOString(), pilots: [] };
  }
  try {
    return JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) as PersistedResults;
  } catch {
    return { version: '1.0.0', generated_at: new Date().toISOString(), pilots: [] };
  }
}

function recordPilot(pilot: PersistedPilot): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const all = loadResults();
  // Drop stale entries from removed pilots; keep only currently-supported names.
  const live = new Set(['realistic-funcs']);
  const filtered = all.pilots.filter((p) => p.name !== pilot.name && live.has(p.name));
  filtered.push(pilot);
  filtered.sort((a, b) => a.name.localeCompare(b.name));
  const out: PersistedResults = {
    version: '1.0.0',
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
// Mock driver — deterministic synthetic data, no API spend
// ---------------------------------------------------------------------------

export const mockDriver: AgentDriver = {
  async runOnce(task, n, condition) {
    const isCoordinated = condition === 'agent-tasks-claim';
    const ALL = ['parseCsv', 'stringifyCsv', 'diffObjects', 'renderTemplate'];
    return {
      run_id: `${task.task_id}-${condition}`,
      workload: task.workload,
      condition,
      total_wall_ms: isCoordinated ? 78700 : 83500,
      merged_tests_passed: isCoordinated,
      agents: Array.from({ length: n }, (_, i) => ({
        agent: `a${i}`,
        files_edited: isCoordinated ? [`${ALL[i % ALL.length]}.js`] : ['shared.js'],
        subgoals: [`implement ${ALL[i % ALL.length]}`],
        tokens: 1500,
        wall_ms: isCoordinated ? 78700 : 83500,
        tests_passed: isCoordinated,
        units_completed: i === 0 ? (isCoordinated ? ALL : [ALL[0], ALL[1], ALL[2]]) : [],
        cost_usd: isCoordinated ? 0.48 : 0.479,
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
// realistic-funcs — 4 non-trivial functions, parallel build
// ---------------------------------------------------------------------------

async function runRealisticFuncs(): Promise<void> {
  const nRuns = getNRuns();
  const fixtureDir = path.resolve('bench/workloads/realistic-funcs');
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
    `  2. Pick the FIRST pending task. Read its description carefully.\n` +
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
      '3 agents in a shared dir with 4 non-trivial functions (parseCsv, stringifyCsv, diffObjects, renderTemplate). Each function is 50-150 LOC of real implementation work, tested by detailed assertions.',
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
    console.log('agent-tasks throughput bench (mock — --real to spawn real agents)\n');
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

  await runRealisticFuncs();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
