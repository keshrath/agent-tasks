/* global process */
// `npm run e2e:claude`: the /pipeline pane suites against the real Claude Code CLI.
// One file at a time: each drives its own Claude Code sessions, and sessions started
// side by side compete for the CPU and the keyboard timing the suites rely on.
import { spawnSync } from 'node:child_process';

const r = spawnSync(
  'npx',
  ['vitest', 'run', 'tests/e2e-claude/', '--no-file-parallelism', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, AGENT_TASKS_E2E_CLAUDE: '1' },
  },
);
process.exit(r.status ?? 1);
