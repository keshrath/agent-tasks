// =============================================================================
// Visibility bench runner.
//
// Builds a frozen mid-feature state, spawns a single "manager" agent in each
// condition (naive file system vs agent-tasks DB+MCP), asks the same 10
// questions, and grades the answers against a known answer key.
//
// `npm run bench:visibility` runs the live bench end-to-end.
// =============================================================================

import { spawn } from 'node:child_process';
import { promises as fs, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { createContext, type AppContext } from '../../src/lib.js';
import { getScenario, type Scenario, type Question } from './scenarios/index.js';

const TMP_ROOT =
  process.env.AGENT_TASKS_BENCH_TMP ??
  (process.platform === 'win32' ? 'C:\\tmp\\agent-tasks-bench' : '/tmp/agent-tasks-bench');

const RESULTS_DIR = path.resolve('bench/_results');
const RESULTS_FILE = path.join(RESULTS_DIR, 'visibility.json');

// ---------------------------------------------------------------------------
// Frozen state setup
// ---------------------------------------------------------------------------

async function writeFiles(dir: string, scenario: Scenario): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const f of scenario.files) {
    const fullPath = path.join(dir, f.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, f.content);
  }
}

function seedDb(dbPath: string, scenario: Scenario): void {
  const ctx: AppContext = createContext({ path: dbPath });
  try {
    // Phase 1: create all tasks (so dependsOn indices can resolve to ids).
    const ids: number[] = [];
    for (const t of scenario.tasks) {
      const created = ctx.tasks.create(
        {
          title: t.title,
          description: t.description,
          project: scenario.project,
          priority: 1,
        },
        'bench-driver',
      );
      ids.push(created.id);
    }

    // Phase 2: dependencies (must be in place BEFORE claim transitions, so
    // the manager can see them when it queries).
    for (const t of scenario.tasks) {
      if (!t.dependsOn) continue;
      for (const parentIdx of t.dependsOn) {
        ctx.tasks.addDependency(ids[t.index], ids[parentIdx], 'blocks');
      }
    }

    // Phase 3: status + stage transitions.
    const stages = ['backlog', 'spec', 'plan', 'implement', 'test', 'review', 'done'];
    for (const t of scenario.tasks) {
      const taskId = ids[t.index];
      if (t.status === 'pending') continue;

      // claim() moves backlog → spec, status → in_progress, sets assignee.
      ctx.tasks.claim(taskId, t.claimer ?? 'bench-driver');

      const targetIdx = stages.indexOf(t.stage);
      // For completed tasks: advance only up to the stage *before* done,
      // then call complete() which handles the final transition + status.
      // For in_progress tasks: advance all the way to the target stage.
      const stopAt = t.status === 'completed' ? Math.min(targetIdx, stages.length - 2) : targetIdx;

      let currentIdx = stages.indexOf('spec'); // post-claim position
      while (currentIdx < stopAt) {
        ctx.tasks.advance(taskId, undefined, 'bench-driver seeding');
        currentIdx++;
      }

      if (t.status === 'completed') {
        // complete() flips status pending/in_progress → completed; the task's
        // stage moves to 'done' regardless of what advance() left it at.
        const live = ctx.tasks.getById(taskId);
        if (live && live.status !== 'completed') {
          ctx.tasks.complete(taskId, t.result ?? 'done');
        }
      }
    }

    // Phase 4: artifacts. Done LAST so they survive any stage transitions.
    for (const t of scenario.tasks) {
      if (!t.artifacts) continue;
      const taskId = ids[t.index];
      for (const a of t.artifacts) {
        if (a.type === 'general') {
          // signature: addArtifact(taskId, name, content, createdBy, stage?)
          ctx.tasks.addArtifact(taskId, a.name ?? 'note', a.content ?? '', 'bench-driver');
        } else if (a.type === 'decision') {
          // Mirror what the MCP `task_artifact type=decision` handler does:
          // build a markdown record and store it as a 'decision' named artifact.
          const content = [
            '## Decision',
            `**Chose:** ${a.chose}`,
            `**Over:** ${a.over}`,
            `**Because:** ${a.because}`,
          ].join('\n');
          ctx.tasks.addArtifact(taskId, 'decision', content, 'bench-driver');
        } else if (a.type === 'comment') {
          // Use the real comment service so the comment shows up under
          // include=['comments'] queries — this is how a real agent would
          // record progress notes.
          ctx.comments.add(taskId, 'bench-driver', a.content ?? '');
        }
      }
    }
  } finally {
    ctx.close();
  }
}

// ---------------------------------------------------------------------------
// Manager prompt construction
// ---------------------------------------------------------------------------

function buildManagerPrompt(scenario: Scenario, condition: 'naive' | 'agent-tasks'): string {
  const questionLines = scenario.questions.map((q) => `Q${q.id}: ${q.text}`).join('\n');
  const nQ = scenario.questions.length;

  const naivePreamble =
    scenario.contextHint +
    '\n\n' +
    `Your tools: you can read files in the current directory. There is no ` +
    `other coordination layer — workers do not write a progress file. You ` +
    `must figure out the state of the project by inspecting the file system ` +
    `alone (source files, README, any notes).`;

  const agentTasksPreamble =
    scenario.contextHint +
    '\n\n' +
    `Your tools: you have the agent-tasks MCP server available. Tasks are in ` +
    `project="${scenario.project}". You can:\n` +
    `  - mcp__agent-tasks__task_list({ project: "${scenario.project}" }) — see all tasks ` +
    `with status, stage, assignee\n` +
    `  - mcp__agent-tasks__task_get({ task_id: <id>, include: ["artifacts", "comments"] }) ` +
    `— read a single task with its spec/decision artifacts AND any comments\n` +
    `Comments contain progress and review notes. Artifacts contain spec text, ` +
    `decision rationale, test results, and review notes.\n\n` +
    `You can also read files in the current directory if you need to verify ` +
    `something against the source. Prefer the task tools for STATE and HISTORY ` +
    `questions because they are authoritative; use file reads only when the ` +
    `question explicitly asks about the implementation.`;

  const protocol =
    `\n\n## Protocol\n\n` +
    `Answer all ${nQ} questions below. For each question, output EXACTLY this ` +
    `format on a single line, no markdown:\n\n` +
    `  ANSWER Q<n>: <your answer in 1-3 sentences>\n\n` +
    `After all ${nQ} answers, output the literal line:\n\n` +
    `  DONE\n\n` +
    `Be concise. If you cannot find the information for a question, write ` +
    `"ANSWER Q<n>: cannot determine from available information."\n\n` +
    `## Questions\n\n${questionLines}\n`;

  return (condition === 'naive' ? naivePreamble : agentTasksPreamble) + protocol;
}

// ---------------------------------------------------------------------------
// Spawn manager agent
// ---------------------------------------------------------------------------

interface ManagerResult {
  raw_stdout: string;
  parsed_answers: Record<number, string>;
  wall_ms: number;
  cost_usd: number;
  tokens: number;
  num_tool_uses?: number;
}

function spawnManager(opts: {
  agentDir: string;
  scratchDir: string;
  logDir: string;
  condition: 'naive' | 'agent-tasks';
  budgetUsd: number;
  dbPath: string;
  scenario: Scenario;
}): Promise<ManagerResult> {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--max-budget-usd',
      String(opts.budgetUsd),
      '--no-session-persistence',
      '--permission-mode',
      'bypassPermissions',
    ];
    if (opts.condition === 'agent-tasks') {
      const indexPath = path.resolve(process.cwd(), 'dist', 'index.js').replace(/\\/g, '/');
      const cfgPath = path.join(opts.scratchDir, `_mcp-cfg-manager.json`);
      writeFileSync(
        cfgPath,
        JSON.stringify({
          mcpServers: {
            'agent-tasks': {
              command: 'node',
              args: [indexPath],
              env: { AGENT_TASKS_DB: opts.dbPath, AGENT_TASKS_INSTRUCTIONS: '0' },
            },
          },
        }),
      );
      args.push('--mcp-config', cfgPath);
    }
    args.push('--', buildManagerPrompt(opts.scenario, opts.condition));

    const start = Date.now();
    const child = spawn('claude', args, {
      cwd: opts.agentDir,
      shell: false,
      env: { ...process.env, AGENT_TASKS_DB: opts.dbPath },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', async () => {
      const wall_ms = Date.now() - start;
      let raw: {
        result?: string;
        total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
        num_turns?: number;
      } | null = null;
      try {
        raw = JSON.parse(stdout);
      } catch {
        /* not json */
      }
      const result_text = raw?.result ?? stdout;
      const cost_usd = raw?.total_cost_usd ?? 0;
      const tokens = (raw?.usage?.input_tokens ?? 0) + (raw?.usage?.output_tokens ?? 0);

      // Persist logs.
      try {
        await fs.writeFile(path.join(opts.logDir, `manager_${opts.condition}_stdout.log`), stdout);
        await fs.writeFile(path.join(opts.logDir, `manager_${opts.condition}_stderr.log`), stderr);
        await fs.writeFile(
          path.join(opts.logDir, `manager_${opts.condition}_result.txt`),
          result_text,
        );
      } catch {
        /* best effort */
      }

      // Parse `ANSWER Q<n>: ...` lines from the result text.
      const parsed_answers: Record<number, string> = {};
      const answerRegex = /ANSWER\s+Q(\d+)\s*:\s*(.+?)(?=\n\s*ANSWER\s+Q\d+\s*:|\n\s*DONE|$)/gis;
      let m: RegExpExecArray | null;
      while ((m = answerRegex.exec(result_text)) !== null) {
        const n = parseInt(m[1], 10);
        parsed_answers[n] = m[2].trim().replace(/\s+/g, ' ');
      }

      resolve({
        raw_stdout: stdout,
        parsed_answers,
        wall_ms,
        cost_usd,
        tokens,
        num_tool_uses: raw?.num_turns,
      });
    });
    child.on('error', () => {
      resolve({
        raw_stdout: stdout,
        parsed_answers: {},
        wall_ms: Date.now() - start,
        cost_usd: 0,
        tokens: 0,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface QuestionScore {
  id: number;
  answer: string;
  score: number;
  matched_groups: number;
  total_groups: number;
  reason: string;
}

function gradeAnswer(q: Question, answer: string | undefined): QuestionScore {
  if (!answer || answer.toLowerCase().includes('cannot determine')) {
    return {
      id: q.id,
      answer: answer ?? '',
      score: 0,
      matched_groups: 0,
      total_groups: q.mustIncludeAllGroups.length,
      reason: 'no answer or "cannot determine"',
    };
  }
  const lower = answer.toLowerCase();
  // Hard-fail phrases
  if (q.mustNotInclude) {
    for (const bad of q.mustNotInclude) {
      if (lower.includes(bad.toLowerCase())) {
        // mustNotInclude is only fatal if it isn't paired with a negation.
        // Cheap heuristic: if "no" or "doesn't" or "drift" is also present,
        // the answer is contrasting against the bad phrase, not endorsing it.
        const hasNegation =
          /\b(no|not|doesn't|does not|drift|mismatch|inconsistent|contradicts)\b/i.test(lower);
        if (!hasNegation) {
          return {
            id: q.id,
            answer,
            score: 0,
            matched_groups: 0,
            total_groups: q.mustIncludeAllGroups.length,
            reason: `contained forbidden phrase "${bad}" without negation`,
          };
        }
      }
    }
  }
  let matched = 0;
  for (const group of q.mustIncludeAllGroups) {
    const hit = group.some((alt) => lower.includes(alt.toLowerCase()));
    if (hit) matched++;
  }
  const total = q.mustIncludeAllGroups.length;
  const score = matched === total ? 1.0 : matched / total >= 0.5 ? 0.5 : 0;
  const reason = matched === total ? 'all groups matched' : `matched ${matched} of ${total} groups`;
  return { id: q.id, answer, score, matched_groups: matched, total_groups: total, reason };
}

function scoreAll(
  scenario: Scenario,
  answers: Record<number, string>,
): { scores: QuestionScore[]; total: number; max: number } {
  const scores = scenario.questions.map((q) => gradeAnswer(q, answers[q.id]));
  const total = scores.reduce((s, x) => s + x.score, 0);
  return { scores, total, max: scenario.questions.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface ConditionRun {
  condition: string;
  wall_seconds: number;
  cost_usd: number;
  tokens: number;
  total_score: number;
  max_score: number;
  per_question: QuestionScore[];
}

async function runCondition(opts: {
  scenario: Scenario;
  condition: 'naive' | 'agent-tasks';
  runId: string;
  budgetUsd: number;
}): Promise<ConditionRun> {
  const runRoot = path.join(TMP_ROOT, `vis-${opts.scenario.name}-${opts.runId}-${opts.condition}`);
  const sharedDir = path.join(runRoot, 'shared');
  const scratchDir = path.join(runRoot, '_scratch');
  const logDir = path.join(runRoot, '_logs');
  await fs.mkdir(scratchDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });
  await writeFiles(sharedDir, opts.scenario);

  const dbPath = path.join(runRoot, 'agent-tasks.sqlite');
  seedDb(dbPath, opts.scenario);

  const result = await spawnManager({
    agentDir: sharedDir,
    scratchDir,
    logDir,
    condition: opts.condition,
    budgetUsd: opts.budgetUsd,
    dbPath,
    scenario: opts.scenario,
  });

  const { scores, total, max } = scoreAll(opts.scenario, result.parsed_answers);

  return {
    condition: opts.condition,
    wall_seconds: result.wall_ms / 1000,
    cost_usd: result.cost_usd,
    tokens: result.tokens,
    total_score: total,
    max_score: max,
    per_question: scores,
  };
}

function formatRun(r: ConditionRun): string {
  return [
    `  ${r.condition.padEnd(15)}`,
    `    score                  ${r.total_score.toFixed(1)} / ${r.max_score}`,
    `    wall_seconds           ${r.wall_seconds.toFixed(1)}s`,
    `    cost_usd               $${r.cost_usd.toFixed(3)}`,
    `    tokens                 ${r.tokens}`,
    `    correct_answers        ${r.per_question.filter((q) => q.score === 1).length}`,
    `    partial_answers        ${r.per_question.filter((q) => q.score === 0.5).length}`,
    `    wrong_answers          ${r.per_question.filter((q) => q.score === 0).length}`,
  ].join('\n');
}

function formatPerQuestionTable(
  scenario: Scenario,
  naive: ConditionRun,
  taskClaim: ConditionRun,
): string {
  const lines: string[] = [];
  lines.push('  Per-question score:');
  lines.push('  Q   naive  agent-tasks  question');
  lines.push('  --  -----  -----------  --------');
  for (const q of scenario.questions) {
    const n = naive.per_question.find((x) => x.id === q.id)!;
    const a = taskClaim.per_question.find((x) => x.id === q.id)!;
    const nf = n.score.toFixed(1).padEnd(5);
    const af = a.score.toFixed(1).padEnd(11);
    const text = q.text.length > 60 ? q.text.slice(0, 57) + '...' : q.text;
    lines.push(`  Q${String(q.id).padStart(2, '0')} ${nf}  ${af}  ${text}`);
  }
  return lines.join('\n');
}

interface PersistedScenario {
  scenario: string;
  description: string;
  n_runs: number;
  naive: ConditionRun[];
  'agent-tasks': ConditionRun[];
}

interface PersistedVisibility {
  generated_at: string;
  scenarios: PersistedScenario[];
}

function recordResults(allResults: PersistedScenario[]): void {
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const out: PersistedVisibility = {
    generated_at: new Date().toISOString(),
    scenarios: allResults,
  };
  writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2));
}

import { SCENARIOS } from './scenarios/index.js';

async function runScenario(scenario: Scenario, nRuns: number): Promise<PersistedScenario> {
  console.log(`\n========================================`);
  console.log(`SCENARIO: ${scenario.name}`);
  console.log(`========================================`);
  console.log(scenario.description);
  console.log(
    `Tasks: ${scenario.tasks.length}, Files: ${scenario.files.length}, Questions: ${scenario.questions.length}\n`,
  );

  const naiveRuns: ConditionRun[] = [];
  const claimRuns: ConditionRun[] = [];

  for (let i = 0; i < nRuns; i++) {
    console.log(`=== Run ${i + 1} of ${nRuns} ===`);
    const runId = `${Date.now()}-${i}`;

    console.log('  spawning naive manager...');
    const n = await runCondition({ scenario, condition: 'naive', runId, budgetUsd: 1.0 });
    naiveRuns.push(n);
    console.log(formatRun(n));

    console.log('  spawning agent-tasks manager...');
    const c = await runCondition({ scenario, condition: 'agent-tasks', runId, budgetUsd: 1.0 });
    claimRuns.push(c);
    console.log(formatRun(c));

    console.log('\n' + formatPerQuestionTable(scenario, n, c) + '\n');
  }

  const avg = (arr: ConditionRun[], pick: (r: ConditionRun) => number) =>
    arr.reduce((s, r) => s + pick(r), 0) / arr.length;
  const max = scenario.questions.length;

  console.log(`=== AGGREGATE for ${scenario.name} (mean across ${nRuns} runs) ===`);
  console.log(`  naive`);
  console.log(`    score        ${avg(naiveRuns, (r) => r.total_score).toFixed(2)} / ${max}`);
  console.log(`    wall         ${avg(naiveRuns, (r) => r.wall_seconds).toFixed(1)}s`);
  console.log(`    cost         $${avg(naiveRuns, (r) => r.cost_usd).toFixed(3)}`);
  console.log(`  agent-tasks`);
  console.log(`    score        ${avg(claimRuns, (r) => r.total_score).toFixed(2)} / ${max}`);
  console.log(`    wall         ${avg(claimRuns, (r) => r.wall_seconds).toFixed(1)}s`);
  console.log(`    cost         $${avg(claimRuns, (r) => r.cost_usd).toFixed(3)}`);

  return {
    scenario: scenario.name,
    description: scenario.description,
    n_runs: nRuns,
    naive: naiveRuns,
    'agent-tasks': claimRuns,
  };
}

async function main(): Promise<void> {
  const real = process.argv.includes('--real');
  const nRunsArg = process.argv.find((a) => a.startsWith('--n-runs='));
  const nRuns = nRunsArg ? Math.max(1, parseInt(nRunsArg.split('=')[1], 10)) : 1;
  const scenarioArg = process.argv.find((a) => a.startsWith('--scenario='));
  const scenarioName = scenarioArg?.split('=')[1] ?? 'all';

  if (!real) {
    console.log('agent-tasks visibility bench (mock — --real to actually spawn agents)\n');
    console.log('Available scenarios:');
    for (const [name, s] of Object.entries(SCENARIOS)) {
      console.log(`  ${name.padEnd(15)} ${s.description}`);
    }
    console.log(`\nRun with: npm run bench:visibility -- --real --scenario=<name> --n-runs=N`);
    console.log(`         npm run bench:visibility -- --real (runs all scenarios)`);
    return;
  }

  const targets = scenarioName === 'all' ? Object.values(SCENARIOS) : [getScenario(scenarioName)];

  console.log(
    `agent-tasks visibility bench (--real, N=${nRuns}, scenarios: ${targets.map((s) => s.name).join(', ')})`,
  );

  const allResults: PersistedScenario[] = [];
  for (const sc of targets) {
    allResults.push(await runScenario(sc, nRuns));
  }

  recordResults(allResults);
  console.log(`\nAll results written to ${RESULTS_FILE}`);

  if (allResults.length > 1) {
    console.log('\n========================================');
    console.log('CROSS-SCENARIO SUMMARY');
    console.log('========================================');
    console.log(`  scenario          naive    agent-tasks   delta`);
    console.log(`  ----------------  -------  ------------  -------`);
    for (const r of allResults) {
      const max = r.naive[0]?.max_score ?? 10;
      const navg = r.naive.reduce((s, x) => s + x.total_score, 0) / r.naive.length;
      const cavg =
        r['agent-tasks'].reduce((s, x) => s + x.total_score, 0) / r['agent-tasks'].length;
      const delta = cavg - navg;
      console.log(
        `  ${r.scenario.padEnd(16)}  ${navg.toFixed(1)}/${max}    ${cavg.toFixed(1)}/${max}        +${delta.toFixed(1)}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
