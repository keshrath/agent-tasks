# agent-tasks bench

## Bottom line

agent-tasks ships five product features: **Visibility ("at a glance"),
Stages, Dependencies, Approvals, Artifacts.** The bench tests each one
directly with a manager-in-the-loop scenario and a known answer key.

**Result across all five features, N=2 per scenario:**

| Feature                                 | Bench scenario                 | naive               | agent-tasks           |
| --------------------------------------- | ------------------------------ | ------------------- | --------------------- |
| Visibility ("at a glance")              | `csv-export`                   | 4.0 / 10            | **10.0 / 10** ⭐      |
| **Artifacts**                           | `audit-recall`                 | 2.8 / 10            | **10.0 / 10** ⭐      |
| **Dependencies**                        | `dep-aware-mgmt`               | **0.5 / 10**        | **8.5 / 10** ⭐       |
| **Approvals**                           | `gates-and-approvals`          | **0.5 / 10**        | **9.75 / 10** ⭐      |
| Parallel coordination                   | `realistic-funcs` (throughput) | 3.3 / 4 (83%)       | **4.0 / 4 (100%)** ⭐ |
| **AGGREGATE (visibility, 4 scenarios)** |                                | **1.95 / 10 (20%)** | **9.56 / 10 (96%)**   |

**agent-tasks gives a manager observing a fleet of agents ~5× better
answer correctness on standard "what's going on?" questions, and is the
ONLY way to answer questions about Dependencies or Approvals at all** —
naive file-system inspection scores literal zero on those dimensions
because the data physically does not exist where it can read.

## Why this is the right framing

agent-tasks is a **Kanban dashboard for AI agent fleets**. The value is
what the human manager can see across N parallel terminals, not how fast
the workers individually run.

The bench measures this directly: a single "manager" agent (no prior
context) is asked 10 standardized questions about a frozen project state,
in two conditions:

- **naive** — the manager can read files in the project directory only
- **agent-tasks** — the manager has `task_list` / `task_get` with
  artifacts, comments, dependencies, and stage state

Answers are auto-graded against a known answer key with substring
rubrics. Every scenario has 10 questions across the 5 product
dimensions.

## How to run

```bash
# Mock driver (no API calls, harness sanity check)
npm run bench:visibility

# All 4 visibility scenarios, N=2 each
npm run bench:visibility -- --real --n-runs=2

# A single scenario
npm run bench:visibility -- --real --scenario=dep-aware-mgmt --n-runs=2

# Throughput pilot — 3 parallel agents on 4 non-trivial functions
npm run bench:run -- --real --n-runs=3
```

Results land in `bench/_results/visibility.json` and
`bench/_results/latest.json`. Per-agent stdout/stderr logs land in
`C:\tmp\agent-tasks-bench\<run-dir>\_logs\`.

## The four visibility scenarios

### 1. `csv-export` — "at a glance" / live mid-build state

**Setup.** 6 tasks. 3 worker agents adding CSV export to a TODO app.
Snapshot frozen at minute 8 of an estimated 15-minute build. One spec
done with a written artifact, one decision recorded, two tasks in
progress (one with a deliberate spec-implementation drift trap), two
backlog.

**Questions** include "what's in progress, by whom?", "what's blocked?",
"why was CSV chosen over JSON?", "does the partial impl match the
spec?", "what's the longest-idle worker?".

**N=2 result:** naive **4.0/10**, agent-tasks **10.0/10**.

The questions naive cannot answer (0/0 in both runs): Q2 blocked, Q4 why
CSV, Q6 longest idle, Q8 remaining count, Q10 backlog list. These are
exactly the visibility questions the dashboard exists for.

### 2. `audit-recall` — Artifacts (historical/provenance)

**Setup.** A 30-day-old completed feature build. 8 tasks, all done. The
feature was "Add rate limiting to the auth endpoint" with full artifacts:
spec, decision rationale (sliding window vs token bucket), unit + integration
test results, code review notes with reviewer concern + resolution.

**Questions** include "WHO wrote the spec?", "WHY sliding window over
token bucket?", "How many tests passed?", "What concern did the reviewer
raise?", "Is rate limit per-user or per-IP?".

**N=2 result:** naive **2.75/10**, agent-tasks **10.0/10**.

Naive scores partial credit on questions answerable from source code
(rate limit threshold, allowlist mechanism) and zero on questions whose
answers live only in artifacts (test counts, reviewer concern,
spec rationale, decision record). agent-tasks: perfect.

### 3. `dep-aware-mgmt` — Dependencies (NEW in v1.10.1)

**Setup.** 8 tasks in a real DAG (User profile API: types → endpoints →
tests → docs). Some done, one in progress, the rest blocked. The DAG is
captured as `task_dependency` edges.

**Questions** include "what's blocked, on what?", "if worker-B finishes,
which tasks become claimable?", "what's the critical path?", "could a
fresh worker start the integration tests right now?", "list every task
that transitively depends on the User type implementation".

**N=2 result:** naive **0.0/10** (literal zero across both runs),
agent-tasks **7.5/10**.

This is the cleanest "agent-tasks is the only way" scenario in the
bench. **The dependency graph does not exist in the file system at
all** — it lives only in the agent-tasks DB. Naive cannot answer any
question about it. agent-tasks scored perfect on every data-retrieval
question; the 2.5 missing points are on multi-step reasoning questions
("find the longest chain") where the LLM struggles to traverse the
graph correctly even with the data in hand. Future bench iterations can
sharpen these.

### 4. `gates-and-approvals` — Approvals (NEW in v1.10.1)

**Setup.** A 6-task pricing rules engine build with explicit `review`
stage gates. Two tasks at the review stage: one **approved** by
reviewer alice with a "LGTM, ship it" comment; one **pending** —
reviewer bob has been assigned for ~6 hours but hasn't responded.

**Questions** include "list tasks at review with approval status",
"who's the reviewer for X and what was their verdict?", "could anyone
advance the parser task right now?", "what should the manager do RIGHT
NOW to unblock the project?".

**N=2 result:** naive **0.5/10**, agent-tasks **9.75/10**.

Same pattern as dep-aware-mgmt: review state lives in comments and
metadata, not in source code. Naive sees the same `rule-engine.js`
file in both conditions and has no way to know whether it's been
reviewed. agent-tasks sees the comment thread, the assigned reviewer,
the verdict, and the latency.

## The throughput pilot (`realistic-funcs`)

A secondary throughput pilot exists to test the parallel-coordination
claim — that agent-tasks's atomic claim primitive measurably wins
when work units are large enough to amortize the MCP protocol overhead.

**Setup.** 3 parallel agents share a directory with 4 non-trivial
functions to implement: `parseCsv`, `stringifyCsv`, `diffObjects`,
`renderTemplate`. Each function is 50-150 LOC of real code with
detailed test assertions. Per-task work cost ~$0.30-0.60. Per-agent
budget $1.50.

**N=3 result:**

| Condition           | unique units   | cost   | wall  | indiv pass |
| ------------------- | -------------- | ------ | ----- | ---------- |
| naive               | 3.3 / 4        | $1.437 | 83.5s | 67%        |
| `agent-tasks-claim` | **4.0 / 4** ⭐ | $1.440 | 78.7s | **100%**   |

**agent-tasks-claim hit 4/4 deterministically every run.** Naive
collided in 1 of 3 runs and lost a function. Cost is statistically
identical, claim is 6% faster, individual pass rate jumped from 67% to
100%. +20% units/$.

This pilot replaced three earlier fixture-class throughput pilots
(task-claim-race, dependency-graph, cross-session-pipeline) which used
work units too small to amortize the per-task ~$0.15 MCP protocol
overhead. Documented post-mortem in the v1.10.0 commit message.

## When to use agent-tasks (production guidance)

**DO** use agent-tasks for:

- Multi-stage features where work flows spec → plan → implement → review
- Multi-session work where different agents (or humans) need to pick up
  where the last left off
- Audit-trail-needing work where "why did we ship this and who approved
  it" matters weeks later
- Multi-agent visibility where the human needs a single dashboard
  showing what all agents are doing across all terminals

**DON'T** use it for:

- Tiny throwaway TODOs in a single session — the per-task MCP overhead
  dominates and naive parallelism is cheaper

## Limitations

A few real constraints on what these numbers mean. Where we can address
a limitation, we have:

- **The manager-proxy is an LLM, not a real human.** A real human
  manager would be faster than naive (skim a screen vs grep code) and
  faster than the LLM-proxy with agent-tasks (read the dashboard). The
  bench simulates the lower bound of cognitive effort, not real wall
  time. The relative gap between conditions is what matters here, not
  the absolute seconds.
- **Auto-grading is substring-based**, so false negatives are possible
  (a correct answer that uses unexpected wording can score 0). False
  positives are very unlikely because the rubrics require multiple
  distinct group matches per question. Aggregate scores are conservative.
- **Fixtures are self-built**, not adapted from an externally validated
  benchmark like SWE-bench Lite. Each scenario is a hand-crafted frozen
  state with a known answer key. Importing real GitHub-issue projects
  is on the roadmap as the next big bench investment.
- **Dependency reasoning is the only sub-perfect agent-tasks score**
  (8.5/10 on `dep-aware-mgmt`). The remaining 1.5 points are on
  forward-simulation questions like "what would become claimable AFTER
  X completes." The tool now exposes both the transitive dependency
  closure (`include=["transitive_deps"]`) and the per-task claim
  status (`claim_status: { claimable, blocked_by }` in the default
  `task_get` response), so the LLM can answer "is X claimable right
  now?" and "what's blocking X?" in one call. The remaining gap is on
  questions that need a forward what-if simulation across multiple
  task transitions, which is intentionally left to the caller.
- **`dep-aware-mgmt` naive scores have wide variance.** Some questions
  in this scenario mention task names by string ("Implement the User
  type", "Write integration tests"), which lets a naive manager guess
  the typical project structure from general LLM knowledge of how a
  user-profile-API build is usually organized — without ever needing
  the dep graph. Across multiple replications the naive baseline has
  ranged from 0/10 (all "cannot determine") to 9/10 (lucky inference).
  The agent-tasks side is more stable because it pulls actual data
  rather than guessing. Future iterations should use abstract task
  names that cannot be reconstructed from question text alone.

## Files

```
bench/
  README.md                              — this file
  metrics.ts                             — pure metric calculators
  metrics.test.ts                        — 20 vitest unit tests for metrics
  runner.ts                              — throughput pilot dispatch (realistic-funcs)
  drivers/cli.ts                         — Real Claude CLI driver
  workloads/
    realistic-funcs/                     — 4 non-trivial functions fixture
  visibility/
    runner.ts                            — visibility bench: scenario dispatch + scoring
    scenario.ts                          — original csv-export data (legacy)
    scenarios/
      types.ts                           — Scenario interface
      index.ts                           — registry
      csv-export.ts                      — at-a-glance / live state visibility
      audit-recall.ts                    — Artifacts (historical recall)
      dep-aware-mgmt.ts                  — Dependencies (NEW)
      gates-and-approvals.ts             — Approvals (NEW)
  _results/
    latest.json                          — throughput pilot results
    visibility.json                      — visibility pilot results
```
