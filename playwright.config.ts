import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e-ui',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
