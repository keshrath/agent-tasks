// =============================================================================
// Scenario B: audit-recall — completed project from "30 days ago"
// =============================================================================
// All 8 tasks DONE. The manager is asked retrospective "why" and "who"
// questions about decisions, test results, and process compliance. The
// answers live in artifacts (specs, decisions) and comments (review notes,
// test outcomes). File system inspection has only the final code — none of
// the rationale.
//
// This tests the AUDIT TRAIL claim: agent-tasks captures structured history
// that survives long after the work itself completes. The naive condition
// has the same source files but no record of WHY anything was chosen.

import type { Scenario } from './types.js';

export const auditRecallScenario: Scenario = {
  name: 'audit-recall',
  description:
    '8 tasks, all DONE. A 30-day-old completed feature build. Tests AUDIT TRAIL recall: why was X chosen, who reviewed Y, what were the test results.',
  project: 'auth-rate-limit',
  contextHint:
    'You are a MANAGER reviewing a feature build that COMPLETED 30 days ago. ' +
    'The feature was "Add rate limiting to the authentication endpoint". All work ' +
    'is finished and merged. You are now doing a retrospective review and need to ' +
    'answer questions about WHY decisions were made, WHO approved them, and what ' +
    'the test results showed before merge.',
  tasks: [
    {
      index: 0,
      title: 'Spec the rate limit policy',
      description:
        'Decide rate limit thresholds, scope (per-IP vs per-user), and behavior on limit hit.',
      stage: 'done',
      status: 'completed',
      claimer: 'worker-spec',
      result: 'Spec approved: 10 req/s per IP, sliding window, 429 on hit',
      artifacts: [
        {
          type: 'general',
          name: 'spec',
          content: `# Auth Rate Limit Spec

**Threshold**: 10 requests / second per source IP.
**Algorithm**: Sliding window (60-second window, 10-req cap).
**Scope**: Per source IP. NOT per authenticated user — the limit must
apply to pre-auth requests too, otherwise an attacker can exhaust the
auth endpoint by trying many usernames.
**On hit**: HTTP 429 with Retry-After header set to remaining window seconds.
**Bypass**: Allowlist for monitoring IPs (configured via env var).
**Storage**: In-memory ring buffer. Acceptable to lose state on restart
because the limit is small enough that 60s of forgiveness is fine.`,
        },
        {
          type: 'comment',
          content:
            'Spec reviewed and approved by worker-reviewer on 2026-03-10. No revisions requested.',
        },
      ],
    },
    {
      index: 1,
      title: 'Decide algorithm: token bucket vs sliding window vs fixed window',
      description: 'Choose the rate limit algorithm.',
      stage: 'done',
      status: 'completed',
      claimer: 'worker-spec',
      result: 'Sliding window chosen (decision recorded)',
      artifacts: [
        {
          type: 'decision',
          chose: 'Sliding window (60s window, 10 req cap)',
          over: 'Token bucket, fixed window',
          because:
            'Token bucket has burst tolerance we explicitly do NOT want for the auth endpoint — an attacker could exhaust the bucket in one burst. Fixed window has the classic edge-of-window doubling problem (10 reqs at 0:59 + 10 reqs at 1:00 = 20 reqs in 1 second). Sliding window is the only option that gives us a smooth rate enforcement without burst tolerance.',
        },
      ],
    },
    {
      index: 2,
      title: 'Implement RateLimiter class',
      description: 'Implement the sliding-window rate limiter per the spec.',
      stage: 'done',
      status: 'completed',
      claimer: 'worker-impl',
      result: 'Implemented in src/rate-limiter.js, 87 LOC',
      artifacts: [
        {
          type: 'comment',
          content:
            'Implementation matches spec exactly. Used a Map<ip, number[]> where the value is an array of timestamps within the current 60s window. shouldAllow(ip) prunes expired timestamps then checks count.',
        },
      ],
    },
    {
      index: 3,
      title: 'Wire RateLimiter into auth middleware',
      description: 'Plug the rate limiter into the auth endpoint as PreToolUse middleware.',
      stage: 'done',
      status: 'completed',
      claimer: 'worker-impl',
      result: 'Middleware wired in src/auth.js',
    },
    {
      index: 4,
      title: 'Unit tests for RateLimiter',
      description: 'Write unit tests for the sliding-window logic.',
      stage: 'done',
      status: 'completed',
      claimer: 'worker-test',
      result: '14 tests, all passing',
      artifacts: [
        {
          type: 'general',
          name: 'test-results',
          content: `# RateLimiter unit test results

Total: 14 tests
Passed: 14
Failed: 0

Coverage:
- shouldAllow under threshold: 4 tests
- shouldAllow at threshold boundary: 3 tests
- shouldAllow above threshold: 2 tests
- window expiry pruning: 3 tests
- allowlist bypass: 2 tests

Edge case results:
- Exactly 10 reqs in 60s: ALLOWED (boundary correct)
- 11th req at 60.001s: ALLOWED (window slid forward)
- 11 reqs in 30s: REJECTED with 429`,
        },
      ],
    },
    {
      index: 5,
      title: 'Integration tests for auth + rate limit',
      description: 'End-to-end test: auth endpoint under rate-limit pressure.',
      stage: 'done',
      status: 'completed',
      claimer: 'worker-test',
      result: '6 integration tests, all passing',
      artifacts: [
        {
          type: 'general',
          name: 'test-results',
          content: `# Auth integration test results

Total: 6 integration tests
Passed: 6
Failed: 0

Scenarios verified:
- Normal auth flow under rate limit: passes through
- Burst attack (50 reqs in 1s from one IP): correctly throttled to 10
- Distributed auth (50 reqs from 50 IPs): all allowed
- Allowlisted IP (monitoring): bypasses limit
- Retry-After header value: correctly reflects remaining window seconds
- Limit recovery after window: requests resume successfully`,
        },
      ],
    },
    {
      index: 6,
      title: 'Code review & approval',
      description: 'Final review before merge.',
      stage: 'done',
      status: 'completed',
      claimer: 'worker-reviewer',
      result: 'Approved by worker-reviewer',
      artifacts: [
        {
          type: 'general',
          name: 'review-notes',
          content: `# Code review for rate-limit feature

**Reviewer**: worker-reviewer
**Approved**: yes
**Revisions requested**: none

Reviewed:
- src/rate-limiter.js — clean, matches spec exactly
- src/auth.js — middleware wired in correct order (before credential check)
- tests/* — comprehensive coverage of edge cases

One concern raised and resolved: I asked whether the in-memory storage
would cause production issues. worker-impl confirmed: acceptable per spec
("Storage: In-memory ring buffer. Acceptable to lose state on restart").
Marking as approved.`,
        },
        {
          type: 'comment',
          content: 'LGTM. Confirmed in-memory storage is acceptable per spec. Approving for merge.',
        },
      ],
    },
    {
      index: 7,
      title: 'Merge to main',
      description: 'Final merge step.',
      stage: 'done',
      status: 'completed',
      claimer: 'worker-merge',
      result: 'Merged to main as commit a1b2c3d',
    },
  ],
  files: [
    {
      path: 'package.json',
      content: '{\n  "type": "commonjs",\n  "name": "auth-service"\n}\n',
    },
    {
      path: 'src/rate-limiter.js',
      content: `// Sliding-window rate limiter, 10 req/s per IP.
// See task #1 for the full spec.

class RateLimiter {
  constructor(maxReqs = 10, windowMs = 60000, allowlist = []) {
    this.maxReqs = maxReqs;
    this.windowMs = windowMs;
    this.allowlist = new Set(allowlist);
    this.reqs = new Map();
  }

  shouldAllow(ip) {
    if (this.allowlist.has(ip)) return { allowed: true, retryAfter: 0 };
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let stamps = this.reqs.get(ip) ?? [];
    stamps = stamps.filter((t) => t >= cutoff);
    if (stamps.length >= this.maxReqs) {
      const oldest = stamps[0];
      return { allowed: false, retryAfter: Math.ceil((oldest + this.windowMs - now) / 1000) };
    }
    stamps.push(now);
    this.reqs.set(ip, stamps);
    return { allowed: true, retryAfter: 0 };
  }
}

module.exports = { RateLimiter };
`,
    },
    {
      path: 'src/auth.js',
      content: `// Auth endpoint with rate-limit middleware.
const { RateLimiter } = require('./rate-limiter.js');

const limiter = new RateLimiter(10, 60000, process.env.RATE_LIMIT_ALLOWLIST?.split(',') ?? []);

function authHandler(req, res) {
  const decision = limiter.shouldAllow(req.ip);
  if (!decision.allowed) {
    res.status(429).set('Retry-After', String(decision.retryAfter));
    return res.json({ error: 'rate_limited' });
  }
  // existing credential check follows here ...
  return doAuth(req, res);
}

function doAuth(req, res) {
  // existing auth logic — unchanged by this feature.
  return res.json({ ok: true });
}

module.exports = { authHandler };
`,
    },
    {
      path: 'README.md',
      content: `# auth-service

Authentication service. Rate limiting was added 30 days ago via the
"Auth Rate Limit" feature build (8 tasks, all completed and merged).

The implementation lives in src/rate-limiter.js. The historical context
(spec, decision rationale, test results, review notes) is captured by
the agent-tasks system, not in this repo.
`,
    },
  ],
  questions: [
    {
      id: 1,
      text: 'WHO wrote the rate limit spec, and is there any record of it being approved?',
      mustIncludeAllGroups: [['worker-spec'], ['approved', 'worker-reviewer', 'review']],
    },
    {
      id: 2,
      text: 'WHY was the SLIDING WINDOW algorithm chosen instead of TOKEN BUCKET? Give the recorded rationale.',
      mustIncludeAllGroups: [['burst', 'attacker', 'exhaust', 'no burst'], ['token bucket']],
    },
    {
      id: 3,
      text: 'How many UNIT tests were written for the RateLimiter, and did they all pass?',
      mustIncludeAllGroups: [
        ['14', 'fourteen'],
        ['pass', 'all passing', 'all 14', 'no failures'],
      ],
    },
    {
      id: 4,
      text: 'How many INTEGRATION tests were written, and what was the result?',
      mustIncludeAllGroups: [
        ['6', 'six'],
        ['pass', 'all passing', 'no failures', 'all 6'],
      ],
    },
    {
      id: 5,
      text: 'Is the rate limit applied PER USER or PER IP? Why? Quote the spec rationale.',
      mustIncludeAllGroups: [
        ['ip', 'per-ip', 'per ip', 'source ip'],
        [
          'attacker',
          'pre-auth',
          'unauthenticated',
          'username',
          'auth endpoint',
          'exhaust',
          'try many',
        ],
      ],
      mustNotInclude: ['per user', 'per-user', 'authenticated user'],
    },
    {
      id: 6,
      text: 'What CONCERN did the code reviewer raise, and how was it resolved?',
      mustIncludeAllGroups: [
        ['in-memory', 'in memory', 'storage', 'memory', 'restart'],
        ['acceptable', 'spec', 'confirmed', 'resolved'],
      ],
    },
    {
      id: 7,
      text: 'What is the SCOPE of the rate limit (e.g. requests per second, window size, threshold)?',
      mustIncludeAllGroups: [
        ['10', 'ten'],
        ['60', 'sixty', '1 minute', 'one minute', 'minute'],
      ],
    },
    {
      id: 8,
      text: 'When the rate limit is HIT, what HTTP status code is returned and what header carries the retry hint?',
      mustIncludeAllGroups: [['429'], ['retry-after', 'retry after']],
    },
    {
      id: 9,
      text: 'Is there an ALLOWLIST mechanism, and how is it configured?',
      mustIncludeAllGroups: [
        ['yes', 'allowlist', 'bypass'],
        ['env', 'environment variable', 'rate_limit_allowlist'],
      ],
    },
    {
      id: 10,
      text: 'List all 8 tasks in this completed project in the order they were worked on (titles only, comma-separated).',
      mustIncludeAllGroups: [
        ['spec'],
        ['decision', 'algorithm', 'token bucket', 'sliding window'],
        ['implement', 'ratelimiter', 'class'],
        ['middleware', 'auth', 'wire'],
        ['unit test', 'unit'],
        ['integration test', 'integration'],
        ['review', 'code review'],
        ['merge'],
      ],
    },
  ],
};
