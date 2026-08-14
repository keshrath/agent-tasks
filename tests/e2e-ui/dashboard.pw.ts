// =============================================================================
// agent-tasks — Playwright E2E dashboard test
//
// Boots the standalone HTTP+WS server against a temp SQLite DB on a free port,
// seeds one task per stage, drives the kanban with chromium, and verifies
// columns + cards render and an advance action moves a card.
// =============================================================================

import { test, expect, type ConsoleMessage, type Route } from '@playwright/test';
import { createContext, type AppContext } from '../../dist/context.js';
import { startDashboard, type DashboardServer } from '../../dist/server.js';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { createServer } from 'net';

const ACTIVE_STAGES = ['backlog', 'spec', 'plan', 'implement', 'test', 'review', 'done'];

function sqliteTimestamp(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

const liveIds = {
  task: 0,
  stale: 0,
  comment: 0,
  artifact: 0,
};

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

function fulfillOptionalResource(route: Route): Promise<void> {
  const resourceType = route.request().resourceType();
  const contentType =
    resourceType === 'stylesheet'
      ? 'text/css'
      : resourceType === 'font'
        ? 'font/woff2'
        : 'application/javascript';
  return route.fulfill({ status: 200, contentType, body: '' });
}

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

  const liveTask = ctx.tasks.create({ title: 'live task', project: 'live-project' }, 'e2e-test');
  const staleTask = ctx.tasks.create({ title: 'stale task', project: 'live-project' }, 'e2e-test');
  const commentTask = ctx.tasks.create(
    { title: 'comment activity', project: 'live-project' },
    'e2e-test',
  );
  const artifactTask = ctx.tasks.create(
    { title: 'artifact activity', project: 'live-project' },
    'e2e-test',
  );
  liveIds.task = liveTask.id;
  liveIds.stale = staleTask.id;
  liveIds.comment = commentTask.id;
  liveIds.artifact = artifactTask.id;

  ctx.db.run('UPDATE tasks SET updated_at = ? WHERE id IN (?, ?, ?, ?)', [
    sqliteTimestamp(5),
    liveTask.id,
    staleTask.id,
    commentTask.id,
    artifactTask.id,
  ]);
  ctx.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [sqliteTimestamp(31), staleTask.id]);

  const comment = ctx.comments.add(commentTask.id, 'e2e-test', 'recent comment');
  ctx.db.run('UPDATE task_comments SET created_at = ? WHERE id = ?', [
    sqliteTimestamp(4),
    comment.id,
  ]);
  const artifact = ctx.tasks.addArtifact(artifactTask.id, 'notes', 'recent artifact', 'e2e-test');
  ctx.db.run('UPDATE task_artifacts SET created_at = ? WHERE id = ?', [
    sqliteTimestamp(3),
    artifact.id,
  ]);
  ctx.db.run('UPDATE tasks SET updated_at = ? WHERE id IN (?, ?)', [
    sqliteTimestamp(31),
    commentTask.id,
    artifactTask.id,
  ]);

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

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', fulfillOptionalResource);
  await page.route('https://fonts.gstatic.com/**', fulfillOptionalResource);
  await page.route('https://cdn.jsdelivr.net/**', fulfillOptionalResource);
});

test.describe('agent-tasks dashboard', () => {
  test('loads with no console errors and connects via websocket', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl + '/', { waitUntil: 'commit' });
    await expect(page.locator('#board')).toBeVisible();
    await expect(page.locator('#connection-status')).toHaveText('Connected', { timeout: 15000 });
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
    await page.goto(baseUrl + '/', { waitUntil: 'commit' });
    await expect(page.locator('#board')).toBeVisible();
    // Wait for the kanban to render columns from initial WS state.
    await expect(page.locator('.kanban-column[data-stage="backlog"]')).toBeVisible({
      timeout: 10000,
    });

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
    await page.goto(baseUrl + '/', { waitUntil: 'commit' });
    await expect(page.locator('#board')).toBeVisible();
    await expect(page.locator('.kanban-column[data-stage="backlog"]')).toBeVisible({
      timeout: 10000,
    });

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

  test('Live shows recent task, comment, and artifact activity and composes with project filter', async ({
    page,
    request,
  }) => {
    await page.goto(baseUrl + '/', { waitUntil: 'commit' });
    await expect(page.locator('.kanban-column[data-stage="backlog"]')).toBeVisible({
      timeout: 10000,
    });

    const liveToggle = page.getByLabel('Filter tasks with activity in the last 30 minutes');
    await expect(liveToggle).toBeVisible();
    await liveToggle.check({ force: true });

    await expect(page.locator(`.task-card[data-task-id="${liveIds.task}"]`)).toBeVisible();
    await expect(page.locator(`.task-card[data-task-id="${liveIds.comment}"]`)).toBeVisible();
    await expect(page.locator(`.task-card[data-task-id="${liveIds.artifact}"]`)).toBeVisible();
    await expect(page.locator(`.task-card[data-task-id="${liveIds.stale}"]`)).toHaveCount(0);

    await page.getByLabel('Filter by project').selectOption('live-project');
    await expect(page.locator('.task-card')).toHaveCount(3);

    // Bump the stale task through the API rather than backdating updated_at in
    // SQL: that is how activity actually happens, and it is what the dashboard
    // is told about.
    const bumpResponse = await request.put(`${baseUrl}/api/tasks/${liveIds.stale}`, {
      data: { description: 'bumped into the live window' },
    });
    expect(bumpResponse.ok()).toBe(true);
    await expect(page.locator(`.task-card[data-task-id="${liveIds.stale}"]`)).toBeVisible({
      timeout: 6000,
    });
    await expect(page.locator('.task-card')).toHaveCount(4);

    const commentResponse = await request.post(`${baseUrl}/api/tasks/${liveIds.stale}/comments`, {
      data: { agent_id: 'e2e-test', content: 'new live activity' },
    });
    expect(commentResponse.ok()).toBe(true);
    await expect(page.locator(`.task-card[data-task-id="${liveIds.stale}"]`)).toBeVisible({
      timeout: 6000,
    });
    await expect(page.locator('.task-card')).toHaveCount(4);

    await page.goto(baseUrl + '/', { waitUntil: 'commit' });
    await expect(page.locator('.kanban-column[data-stage="backlog"]')).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.getByLabel('Filter tasks with activity in the last 30 minutes'),
    ).toBeChecked();

    const invalidActivityAccepted = await page.evaluate(() => {
      type BoardWindow = Window & {
        TaskBoard: {
          hasRecentActivity(task: { id: number; updated_at?: string }): boolean;
        };
      };
      const originalNow = Date.now;
      Date.now = () => Date.parse('2026-03-02T12:30:00Z');
      try {
        const board = (window as BoardWindow).TaskBoard;
        return [
          board.hasRecentActivity({ id: -1, updated_at: '2026-03-02 12:00:00' }),
          board.hasRecentActivity({ id: -2, updated_at: '2026-03-02 12:00:01' }),
          board.hasRecentActivity({ id: -3, updated_at: '2026-03-02 12:31:00' }),
          board.hasRecentActivity({ id: -4 }),
          board.hasRecentActivity({ id: -5, updated_at: '2026-02-30 12:00:00' }),
        ];
      } finally {
        Date.now = originalNow;
      }
    });
    expect(invalidActivityAccepted).toEqual([false, true, false, false, false]);

    const pluginFilterExists = await page.evaluate(() => {
      type PluginWindow = Window & {
        TaskBoard: {
          mount(container: HTMLElement, options: { wsUrl: string }): void;
          unmount(): void;
        };
      };
      const container = document.createElement('div');
      document.body.appendChild(container);
      const board = (window as PluginWindow).TaskBoard;
      board.mount(container, { wsUrl: location.host });
      const exists = Boolean(container.shadowRoot?.getElementById('filter-live'));
      board.unmount();
      container.remove();
      return exists;
    });
    expect(pluginFilterExists).toBe(true);
  });
});
