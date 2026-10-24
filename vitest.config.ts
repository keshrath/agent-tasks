import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    // The bridges point nowhere: tests never reach the agent-comm or agent-knowledge running
    // on this machine (nor send them the tasks a test makes).
    env: { AGENT_COMM_URL: 'http://127.0.0.1:1', AGENT_KNOWLEDGE_URL: 'http://127.0.0.1:1' },
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**', '**/.claude/**', 'plugin/**'],
  },
});
