// =============================================================================
// Benchmark metric calculators — pure functions, no I/O.
//
// These compute the headline numbers from raw run data. They are deliberately
// decoupled from any agent driver so the math can be unit-tested in isolation
// before spending tokens on real subagent runs.
//
// See bench/README.md for metric definitions and the underlying methodology.
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRun {
  agent: string;
  // Files this agent edited (relative repo paths).
  files_edited: string[];
  // Sub-goals this agent generated, as raw natural-language strings.
  subgoals: string[];
  // Token usage for this agent's run.
  tokens: number;
  // Wall-clock duration in milliseconds.
  wall_ms: number;
  // Whether the agent's final test suite passed (used for collision detection).
  tests_passed: boolean;
  // Workload-specific: which named units/functions this agent successfully
  // completed. Empty for workloads that don't track sub-units.
  units_completed?: string[];
  // Workload-specific: USD cost for this agent's run (if known). Falls back
  // to an estimate if absent.
  cost_usd?: number;
}

export interface MultiAgentRun {
  run_id: string;
  workload: string;
  condition: 'control' | 'agent-tasks-claim';
  agents: AgentRun[];
  // Total wall-clock for the whole multi-agent run (max, not sum).
  total_wall_ms: number;
  // Tests passing AFTER merging all agents' work (collision signal).
  merged_tests_passed: boolean;
}

// ---------------------------------------------------------------------------
// File collision rate
// ---------------------------------------------------------------------------

/**
 * A run "collides" if two or more agents edited the same file AND the merged
 * test suite did not pass. Editing the same file is fine if the merge is clean;
 * we only count it as a collision when it actually broke something.
 */
export function runHasCollision(run: MultiAgentRun): boolean {
  const fileToAgents = new Map<string, Set<string>>();
  for (const agent of run.agents) {
    for (const file of agent.files_edited) {
      if (!fileToAgents.has(file)) fileToAgents.set(file, new Set());
      fileToAgents.get(file)!.add(agent.agent);
    }
  }
  const overlapping = [...fileToAgents.values()].some((s) => s.size >= 2);
  return overlapping && !run.merged_tests_passed;
}

export function fileCollisionRate(runs: MultiAgentRun[]): number {
  if (runs.length === 0) return 0;
  return runs.filter(runHasCollision).length / runs.length;
}

// ---------------------------------------------------------------------------
// Duplicate sub-goal rate (ToM-style)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'by',
  'is',
  'are',
  'be',
  'this',
  'that',
  'it',
  'as',
  'at',
]);

export function normalizeSubgoal(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  // Empty sub-goals carry no signal — never call them duplicates of anything.
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const x of a) if (b.has(x)) intersect++;
  const union = a.size + b.size - intersect;
  return intersect / union;
}

/**
 * Count duplicate sub-goals across agents in a run. A sub-goal is "duplicate"
 * if it has Jaccard ≥ threshold with any sub-goal from a different agent.
 *
 * Returns { total, duplicates } so the caller can aggregate across runs.
 */
export function countDuplicateSubgoals(
  run: MultiAgentRun,
  threshold = 0.8,
): { total: number; duplicates: number } {
  const all: { agent: string; tokens: Set<string> }[] = [];
  for (const agent of run.agents) {
    for (const sg of agent.subgoals) {
      all.push({ agent: agent.agent, tokens: normalizeSubgoal(sg) });
    }
  }

  // A sub-goal is "duplicate" if any sub-goal from a *different* agent matches
  // it above the threshold. Both sides of a match count: if two agents
  // independently propose the same goal, that's 2 wasted slots, not 1.
  let duplicates = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = 0; j < all.length; j++) {
      if (i === j) continue;
      if (all[i].agent === all[j].agent) continue;
      if (jaccard(all[i].tokens, all[j].tokens) >= threshold) {
        duplicates++;
        break;
      }
    }
  }
  return { total: all.length, duplicates };
}

export function duplicateSubgoalRate(runs: MultiAgentRun[], threshold = 0.8): number {
  let total = 0;
  let dup = 0;
  for (const run of runs) {
    const c = countDuplicateSubgoals(run, threshold);
    total += c.total;
    dup += c.duplicates;
  }
  return total === 0 ? 0 : dup / total;
}

// ---------------------------------------------------------------------------
// Tradeoff axes — always reported alongside headline metrics
// ---------------------------------------------------------------------------

/** Total tokens / tokens of the single best-performing agent in the run. */
export function tokenOverheadRatio(run: MultiAgentRun): number {
  const passing = run.agents.filter((a) => a.tests_passed);
  if (passing.length === 0) return Infinity;
  const bestSolo = Math.min(...passing.map((a) => a.tokens));
  const total = run.agents.reduce((s, a) => s + a.tokens, 0);
  return total / bestSolo;
}

/** sum(per-agent wall) / total wall. 1.0 = serial, N = perfect parallelism. */
export function parallelismRatio(run: MultiAgentRun): number {
  if (run.total_wall_ms === 0) return 0;
  const sum = run.agents.reduce((s, a) => s + a.wall_ms, 0);
  return sum / run.total_wall_ms;
}

// ---------------------------------------------------------------------------
// Aggregated report
// ---------------------------------------------------------------------------

export interface BenchReport {
  workload: string;
  condition: MultiAgentRun['condition'];
  n_runs: number;
  file_collision_rate: number;
  duplicate_subgoal_rate: number;
  mean_token_overhead: number;
  mean_parallelism: number;
  /** Fraction of agents (across all runs) whose own test suite passed. */
  individual_pass_rate: number;
  /** Fraction of runs where the merged-tests proxy passed. */
  merged_pass_rate: number;
  /** Avg unique units completed across the team (deduped). 0 if not tracked. */
  mean_unique_units: number;
  /** Total USD across all agents averaged across runs. 0 if not tracked. */
  mean_total_cost_usd: number;
  /** Headline efficiency: unique units / total dollars. 0 if cost or units missing. */
  units_per_dollar: number;
  /** Mean wall-clock time of the whole run in seconds. */
  mean_wall_seconds: number;
}

export function aggregate(runs: MultiAgentRun[]): BenchReport {
  if (runs.length === 0) {
    throw new Error('aggregate: empty run list');
  }
  const finite = (x: number) => (Number.isFinite(x) ? x : 0);
  let agentTotal = 0;
  let agentPass = 0;
  for (const r of runs) {
    for (const a of r.agents) {
      agentTotal++;
      if (a.tests_passed) agentPass++;
    }
  }
  // Per-run unique units (dedup across agents) and total cost.
  let totalUnique = 0;
  let totalCost = 0;
  let costRunsCounted = 0;
  for (const r of runs) {
    const unique = new Set<string>();
    let runCost = 0;
    let anyCost = false;
    for (const a of r.agents) {
      for (const u of a.units_completed ?? []) unique.add(u);
      if (typeof a.cost_usd === 'number') {
        runCost += a.cost_usd;
        anyCost = true;
      }
    }
    totalUnique += unique.size;
    if (anyCost) {
      totalCost += runCost;
      costRunsCounted++;
    }
  }
  const meanUnique = totalUnique / runs.length;
  const meanCost = costRunsCounted === 0 ? 0 : totalCost / costRunsCounted;
  const unitsPerDollar = meanCost > 0 ? meanUnique / meanCost : 0;
  return {
    workload: runs[0].workload,
    condition: runs[0].condition,
    n_runs: runs.length,
    file_collision_rate: fileCollisionRate(runs),
    duplicate_subgoal_rate: duplicateSubgoalRate(runs),
    mean_token_overhead: runs.reduce((s, r) => s + finite(tokenOverheadRatio(r)), 0) / runs.length,
    mean_parallelism: runs.reduce((s, r) => s + parallelismRatio(r), 0) / runs.length,
    individual_pass_rate: agentTotal === 0 ? 0 : agentPass / agentTotal,
    merged_pass_rate: runs.filter((r) => r.merged_tests_passed).length / runs.length,
    mean_unique_units: meanUnique,
    mean_total_cost_usd: meanCost,
    units_per_dollar: unitsPerDollar,
    mean_wall_seconds: runs.reduce((s, r) => s + r.total_wall_ms, 0) / runs.length / 1000,
  };
}
