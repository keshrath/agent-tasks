/* global process */
// `npm run e2e:claude`: the /pipeline pane suite against the real Claude Code CLI.
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['vitest', 'run', 'tests/e2e-claude/', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, AGENT_TASKS_E2E_CLAUDE: '1' },
});
process.exit(r.status ?? 1);
