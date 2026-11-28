// The dashboard e2e (npm run e2e:web): every flow against a real server on a
// scratch database and port (server.ts). Output lands in ~/.claude/tmp/at-web.
import { defineConfig } from '@playwright/test';
import { homedir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: '.',
  testMatch: '*.pw.ts',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  outputDir: join(homedir(), '.claude', 'tmp', 'at-web', 'pw-out'),
  use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, trace: 'off' },
});
