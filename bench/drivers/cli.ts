// =============================================================================
// Real AgentDriver — spawns headless Claude Code subagents via the CLI.
//
// Each agent runs in a (per-agent or shared) tmp dir copy of the workload
// fixture. The driver:
//   1. Creates a fresh shared SQLite DB at C:\tmp\agent-tasks-bench\<run>\db.sqlite
//   2. For agent-tasks-claim conditions: pre-creates one task per work unit via
//      TaskService (using the same DB the spawned MCP servers will read).
//   3. Spawns `claude -p` agents in parallel; each agent's --mcp-config points
//      at agent-tasks dist/index.js with AGENT_TASKS_DB env set to the shared DB.
//   4. Reads the run's test command for unit-level pass/fail.
//
// Cost discipline: every agent gets a hard --max-budget-usd cap.
// =============================================================================

import { spawn } from 'node:child_process';
import { promises as fs, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { AgentDriver, WorkloadTask } from '../runner.js';
import type { AgentRun, MultiAgentRun } from '../metrics.js';
import { createContext, type AppContext } from '../../src/lib.js';

// Tmp lives OUTSIDE ~/.claude/ — Claude Code hard-blocks writes there even
// with --permission-mode bypassPermissions.
const TMP_ROOT =
  process.env.AGENT_TASKS_BENCH_TMP ??
  (process.platform === 'win32' ? 'C:\\tmp\\agent-tasks-bench' : '/tmp/agent-tasks-bench');

export interface CliDriverOptions {
  fixtureDir: string;
  testCmd: string;
  maxBudgetUsd: number;
  /** Names of files (one per work unit) the agents are expected to edit. */
  expectedFiles: string[];
  /** When true, all agents share ONE working dir (real shared-file race). */
  sharedDir?: boolean;
  /** Per-agent prompt builder — required to assign distinct work or just
   * inject the right protocol instructions per condition. */
  promptForAgent?: (agentIndex: number, ctx: { taskIds?: number[] }) => string;
  /** When true, agents run sequentially instead of in parallel. */
  sequentialAgents?: boolean;
  /** Optional task descriptions paired 1:1 with `expectedFiles`. When set, the
   * pre-seeded backlog tasks use these descriptions instead of the generic
   * "Implement <file>" template. */
  taskDescriptions?: string[];
}

const SUBGOAL_INSTRUCTION = `
Before doing any work, write a file called subgoals.json in the current
directory containing a JSON array of strings. Each string is one short sub-goal
you plan to accomplish. Then implement whatever the task requires.
`.trim();

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

interface ClaudeJsonResult {
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  result?: string;
  is_error?: boolean;
}

interface SpawnOptions {
  agentDir: string;
  logDir: string;
  agentName: string;
  prompt: string;
  budgetUsd: number;
  withMcp: boolean;
  scratchDir: string;
  dbPath: string;
}

function spawnClaude(
  opts: SpawnOptions,
): Promise<{ tokens: number; wall_ms: number; raw: ClaudeJsonResult | null; stderr: string }> {
  return new Promise((resolve) => {
    const { agentDir, logDir, agentName, prompt, budgetUsd, withMcp, scratchDir, dbPath } = opts;
    const args = [
      '-p',
      '--output-format',
      'json',
      '--max-budget-usd',
      String(budgetUsd),
      '--no-session-persistence',
      '--permission-mode',
      'bypassPermissions',
    ];
    if (withMcp) {
      const indexPath = path.resolve(process.cwd(), 'dist', 'index.js').replace(/\\/g, '/');
      const cfgPath = path.join(scratchDir, `_mcp-cfg-${agentName}.json`);
      writeFileSync(
        cfgPath,
        JSON.stringify({
          mcpServers: {
            'agent-tasks': {
              command: 'node',
              args: [indexPath],
              env: { AGENT_TASKS_DB: dbPath, AGENT_TASKS_INSTRUCTIONS: '0' },
            },
          },
        }),
      );
      args.push('--mcp-config', cfgPath);
    }
    // The `--` separator is REQUIRED — --mcp-config is variadic and would
    // otherwise consume the prompt.
    args.push('--', prompt);

    const start = Date.now();
    const child = spawn('claude', args, {
      cwd: agentDir,
      shell: false,
      env: { ...process.env, AGENT_TASKS_DB: dbPath },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', async () => {
      const wall_ms = Date.now() - start;
      let raw: ClaudeJsonResult | null = null;
      try {
        raw = JSON.parse(stdout);
      } catch {
        /* not valid json */
      }
      try {
        await fs.writeFile(path.join(logDir, `${agentName}_stdout.log`), stdout);
        await fs.writeFile(path.join(logDir, `${agentName}_stderr.log`), stderr);
      } catch {
        /* best effort */
      }
      const tokens = (raw?.usage?.input_tokens ?? 0) + (raw?.usage?.output_tokens ?? 0);
      resolve({ tokens, wall_ms, raw, stderr });
    });
    child.on('error', () => {
      resolve({ tokens: 0, wall_ms: Date.now() - start, raw: null, stderr });
    });
  });
}

export function makeCliDriver(opts: CliDriverOptions): AgentDriver {
  return {
    async runOnce(task: WorkloadTask, n: number, condition): Promise<MultiAgentRun> {
      const runId = `${task.task_id}-${condition}-${Date.now()}`;
      const runRoot = path.join(TMP_ROOT, `bench-${runId}`);
      await fs.mkdir(runRoot, { recursive: true });

      const withMcp = condition === 'agent-tasks-claim';
      const dbPath = path.join(runRoot, 'agent-tasks.sqlite');

      let seedCtx: AppContext | null = null;
      const taskIds: number[] = [];
      if (condition === 'agent-tasks-claim') {
        seedCtx = createContext({ path: dbPath });
        for (let i = 0; i < opts.expectedFiles.length; i++) {
          const file = opts.expectedFiles[i];
          const description =
            opts.taskDescriptions?.[i] ??
            `Implement the TODO function in the file ${file} in your working directory. Run \`node test.js\` and confirm your function is in the PASSED_FNS output.`;
          const t = seedCtx.tasks.create(
            {
              title: `Implement ${file}`,
              description,
              project: 'bench',
              priority: 1,
            },
            'bench-driver',
          );
          taskIds.push(t.id);
        }
      }

      // Per-agent vs shared dir.
      const scratchDir = path.join(runRoot, '_scratch');
      await fs.mkdir(scratchDir, { recursive: true });
      const agentDirs: string[] = [];
      let sharedAgentDir = '';
      if (opts.sharedDir) {
        sharedAgentDir = path.join(runRoot, 'shared');
        await copyDir(opts.fixtureDir, sharedAgentDir);
        for (let i = 0; i < n; i++) agentDirs.push(sharedAgentDir);
      } else {
        for (let i = 0; i < n; i++) {
          const dir = path.join(runRoot, `a${i}`);
          await copyDir(opts.fixtureDir, dir);
          agentDirs.push(dir);
        }
      }

      function buildPrompt(i: number): string {
        const base = opts.promptForAgent ? opts.promptForAgent(i, { taskIds }) : task.prompt;
        return [base, SUBGOAL_INSTRUCTION].join('\n\n');
      }

      const logDir = path.join(runRoot, '_logs');
      await fs.mkdir(logDir, { recursive: true });
      const totalStart = Date.now();
      let results: Array<{
        tokens: number;
        wall_ms: number;
        raw: ClaudeJsonResult | null;
        stderr: string;
      }>;
      if (opts.sequentialAgents) {
        results = [];
        for (let i = 0; i < n; i++) {
          results.push(
            await spawnClaude({
              agentDir: agentDirs[i],
              logDir,
              agentName: `a${i}`,
              prompt: buildPrompt(i),
              budgetUsd: opts.maxBudgetUsd,
              withMcp,
              scratchDir,
              dbPath,
            }),
          );
        }
      } else {
        results = await Promise.all(
          agentDirs.map((dir, i) =>
            spawnClaude({
              agentDir: dir,
              logDir,
              agentName: `a${i}`,
              prompt: buildPrompt(i),
              budgetUsd: opts.maxBudgetUsd,
              withMcp,
              scratchDir,
              dbPath,
            }),
          ),
        );
      }
      const total_wall_ms = Date.now() - totalStart;

      // Per-agent results. In sharedDir mode the merged state IS the shared
      // dir, so we run the test command once and attribute units to a0.
      const agents: AgentRun[] = [];
      if (opts.sharedDir) {
        const sharedTest = await runTest(sharedAgentDir, opts.testCmd);
        for (let i = 0; i < n; i++) {
          const r = results[i];
          agents.push({
            agent: `a${i}`,
            files_edited: [],
            subgoals: [],
            tokens: r.tokens,
            wall_ms: r.wall_ms,
            tests_passed: sharedTest.passed,
            units_completed: i === 0 ? sharedTest.units : [],
            cost_usd: r.raw?.total_cost_usd,
          });
        }
      } else {
        for (let i = 0; i < n; i++) {
          const dir = agentDirs[i];
          const r = results[i];
          const test = await runTest(dir, opts.testCmd);
          agents.push({
            agent: `a${i}`,
            files_edited: [],
            subgoals: [],
            tokens: r.tokens,
            wall_ms: r.wall_ms,
            tests_passed: test.passed,
            units_completed: test.units,
            cost_usd: r.raw?.total_cost_usd,
          });
        }
      }

      const allPassed = agents.every((a) => a.tests_passed);

      if (seedCtx) {
        try {
          seedCtx.close();
        } catch {
          /* best effort */
        }
      }

      return {
        run_id: runId,
        workload: task.workload,
        condition,
        agents,
        total_wall_ms,
        merged_tests_passed: allPassed,
      };
    },
  };
}

function runTest(dir: string, cmd: string): Promise<{ passed: boolean; units: string[] }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd: dir, shell: true });
    let stdout = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', () => {});
    child.on('close', (code) => {
      const m = /^PASSED_FNS=(.*)$/m.exec(stdout);
      const units = m ? m[1].split(',').filter((s) => s.length > 0) : [];
      resolve({ passed: code === 0, units });
    });
    child.on('error', () => resolve({ passed: false, units: [] }));
  });
}
