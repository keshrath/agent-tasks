// =============================================================================
// agent-tasks — Playwright E2E dashboard test
//
// Boots the standalone HTTP+WS server against a temp SQLite DB on a free port,
// seeds one task per stage, drives the kanban with chromium, and verifies
// columns + cards render and an advance action moves a card.
// =============================================================================

import { test, expect, type ConsoleMessage } from '@playwright/test';
import { createContext, type AppContext } from '../../dist/context.js';
import { startDashboard, type DashboardServer } from '../../dist/server.js';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { createServer } from 'net';

const ACTIVE_STAGES = ['backlog', 'spec', 'plan', 'implement', 'test', 'review', 'done'];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('no port'));
      }
    });
  });
}

let tempDir: string;
let ctx: AppContext;
let dashboard: DashboardServer;
let baseUrl: string;
const seededIds = new Map<string, number>();

test.beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-tasks-e2e-'));
  ctx = createContext({ path: join(tempDir, 'test.db') });

  for (const stage of ACTIVE_STAGES) {
    const t = ctx.tasks.create(
      {
        title: `e2e seed ${stage}`,
        description: `seeded for stage ${stage}`,
        project: 'e2e',
        stage,
        priority: 1,
      },
      'e2e-test',
    );
    seededIds.set(stage, t.id);
  }

  const port = await freePort();
  dashboard = await startDashboard(ctx, port);
  baseUrl = `http://localhost:${dashboard.port}`;
});

test.afterAll(async () => {
  try {
    dashboard?.close();
  } catch {
    /* ignore */
  }
  try {
    ctx?.close();
  } catch {
    /* ignore */
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test.describe('agent-tasks dashboard', () => {
  test('loads with no console errors and connects via websocket', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    let wsConnected = false;
    page.on('websocket', () => {
      wsConnected = true;
    });

    await page.goto(baseUrl + '/');
    await expect(page.locator('#board')).toBeVisible();
    await page.waitForTimeout(800);

    expect(wsConnected).toBe(true);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);

    const screenshotDir = join(homedir(), '.claude', 'tmp');
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: join(screenshotDir, 'e2e-agent-tasks.png'),
      fullPage: true,
    });
  });

  test('every stage column renders with its seeded card', async ({ page }) => {
    await page.goto(baseUrl + '/');
    await expect(page.locator('#board')).toBeVisible();
    // Wait for the kanban to render columns from initial WS state.
    await page.waitForSelector('.kanban-column[data-stage="backlog"]', { timeout: 5000 });

    for (const stage of ACTIVE_STAGES) {
      const col = page.locator(`.kanban-column[data-stage="${stage}"]`);
      await expect(col).toBeVisible();
      const id = seededIds.get(stage)!;
      await expect(col.locator(`.task-card[data-task-id="${id}"]`)).toBeVisible();
    }
  });

  test('REST advance moves a card to the next stage and WS reflects it', async ({
    page,
    request,
  }) => {
    await page.goto(baseUrl + '/');
    await expect(page.locator('#board')).toBeVisible();
    await page.waitForSelector('.kanban-column[data-stage="backlog"]');

    const id = seededIds.get('backlog')!;
    const res = await request.put(`${baseUrl}/api/tasks/${id}/stage`, {
      data: { stage: 'spec' },
    });
    expect(res.ok()).toBe(true);

    // The dashboard polls the DB every 2s — wait for the card to migrate.
    await expect(
      page.locator(`.kanban-column[data-stage="spec"] .task-card[data-task-id="${id}"]`),
    ).toBeVisible({ timeout: 6000 });
  });
});
