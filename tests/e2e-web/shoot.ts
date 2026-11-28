// =============================================================================
// The dashboard screenshots in docs/images/dashboard/ (light, dark, task detail,
// stats, mobile), taken from a real server over the seeded scratch board.
//   npx tsx tests/e2e-web/shoot.ts [outDir]
// =============================================================================

import { chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { disposeServer, startServer } from './server.js';

const out = process.argv[2] ?? join(import.meta.dirname, '..', '..', 'docs', 'images', 'dashboard');
mkdirSync(out, { recursive: true });
const server = await startServer();
const browser = await chromium.launch();

async function open(
  name: string,
  hash: string,
  o: { width?: number; height?: number; dark?: boolean; full?: boolean } = {},
  act?: (page: Page) => Promise<void>,
) {
  const page = await browser.newPage({
    viewport: { width: o.width ?? 1440, height: o.height ?? 900 },
    deviceScaleFactor: 2,
    colorScheme: o.dark ? 'dark' : 'light',
  });
  await page.goto(`${server.url}${hash}`);
  await page.locator('.server.is-up').waitFor();
  await page.locator('.card, .done-row, .chart').first().waitFor();
  if (hash.match(/\/\d+$/)) await page.locator('.detail-title').waitFor();
  await act?.(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: o.full ?? false });
  await page.close();
}

try {
  const { working } = server.ids;
  await open('board-light', '#/board');
  await open('board-dark', '#/board', { dark: true });
  await open('detail-light', `#/board/${working}`);
  await open('detail-dark', `#/board/${working}`, { dark: true }, async (p) => {
    await p.locator('.artifact summary').first().click();
  });
  await open('stats-light', '#/stats');
  await open('done-light', '#/done');
  await open('mobile-board', '#/board', { width: 390, height: 844 });
  await open('mobile-detail', `#/board/${working}`, { width: 390, height: 844, dark: true });
} finally {
  await browser.close();
  await disposeServer(server);
}
console.error(`screenshots in ${out}`);
