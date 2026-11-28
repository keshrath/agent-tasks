// =============================================================================
// The web dashboard end to end: a real REST server (dist/server.js) on a
// scratch database and a free port per test, driven in Chromium. Board,
// filters, detail, every stage action, create, comment, live updates from a
// second client, the server going away and coming back, phone width, dark mode
// and the keyboard.
// =============================================================================

import { test as base, expect, type Page } from '@playwright/test';
import { disposeServer, startServer, type TestServer } from './server.js';

const test = base.extend<{ server: TestServer; board: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright wants a destructured first argument
  server: async ({}, use) => {
    const s = await startServer();
    await use(s);
    await disposeServer(s);
  },
  board: async ({ page, server }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(m.text()))
        errors.push(m.text());
    });
    page.on('dialog', (d) => {
      errors.push(`unexpected dialog: ${d.message()}`);
      void d.dismiss();
    });
    await page.goto(server.url);
    await expect(page.locator('.server')).toHaveText('Live');
    await use(page);
    expect(errors).toEqual([]);
  },
});

async function rest(server: TestServer, path: string, init?: RequestInit) {
  const res = await fetch(`${server.url.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  return res.json();
}
const getTask = (server: TestServer, id: number) =>
  rest(server, `/api/tasks/${id}?include=comments`);
const card = (page: Page, id: number) => page.locator(`.card[data-id="${id}"]`);
const column = (page: Page, stage: string) =>
  page.locator('.column', {
    has: page.locator('.column-head h2', { hasText: new RegExp(`^${stage}$`) }),
  });

async function openTask(page: Page, id: number) {
  await card(page, id).locator('.card-open').click();
  await expect(page.locator('.detail-title')).toBeVisible();
}

test.describe('board', () => {
  test('header, tiles and a column per stage with its cards', async ({ board, server }) => {
    await expect(board.locator('.brand-name')).toHaveText('agent-tasks');
    await expect(board.locator('.version')).toHaveText(/^v\d+\.\d+\.\d+$/);
    await expect(board.locator('.tab.is-active')).toContainText('Board');
    await expect(board.locator('.tile').first()).toContainText('11open');
    await expect(board.locator('.tile', { hasText: 'blocked' })).toContainText('1');
    await expect(board.locator('.column-head h2')).toHaveText([
      'backlog',
      'spec',
      'plan',
      'implement',
      'test',
      'review',
    ]);
    const working = card(board, server.ids.working);
    await expect(
      column(board, 'implement').locator(`.card[data-id="${server.ids.working}"]`),
    ).toBeVisible();
    await expect(working).toContainText('Rate-limit the public search endpoint');
    await expect(working).toContainText('P5');
    await expect(working).toContainText('alice');
    await expect(working).toContainText('api');
    await expect(working).toContainText('backend');
    await expect(card(board, server.ids.blocked)).toContainText(`waits for #${server.ids.working}`);
    await expect(card(board, server.ids.parent)).toContainText('0/2 subtasks');
    await expect(card(board, server.ids.unclaimed).locator('.who')).toHaveText('unclaimed');
  });

  test('find, project and assignee filters, and Clear', async ({ board, server }) => {
    const find = board.getByRole('searchbox', { name: 'Find tasks' });
    await find.fill('rate-limit');
    await expect(board.locator('.card')).toHaveCount(1);
    await find.fill(`#${server.ids.blocked}`);
    await expect(board.locator('.card')).toHaveCount(1);
    await find.fill('spike');
    await expect(board.locator('.card')).toHaveText(/Evaluate SQLite FTS5/);
    await find.fill('nothing like this');
    await expect(board.locator('.empty')).toHaveText('No open task matches the filters.');
    await expect(board.locator('.column')).toHaveCount(0);
    await board.getByRole('button', { name: 'Clear' }).click();
    await expect(board.locator('.card')).toHaveCount(11);

    await board.getByRole('combobox', { name: 'All projects' }).selectOption('web');
    await expect(board.locator('.card')).toHaveCount(4);
    await board.getByRole('combobox', { name: 'All assignees' }).selectOption('carol');
    await expect(board.locator('.card')).toHaveCount(2);
    await board.getByRole('combobox', { name: 'All projects' }).selectOption('');
    await board.getByRole('combobox', { name: 'All assignees' }).selectOption('unclaimed');
    await expect(board.locator('.card')).toHaveCount(4);
    await expect(find).toBeVisible();
  });

  test('Done lists finished work, filters it and opens it', async ({ board, server }) => {
    await board.getByRole('button', { name: 'Done' }).click();
    await expect(board).toHaveURL(/#\/done$/);
    await expect(board.locator('.done-row')).toHaveCount(10);
    await expect(board.locator(`.done-row[data-id="${server.ids.finished}"]`)).toContainText(
      'Digest uses the recipient timezone',
    );
    await board.getByRole('searchbox', { name: 'Find tasks' }).fill('bun');
    await expect(board.locator('.done-row')).toHaveCount(1);
    await expect(board.locator('.done-row')).toContainText('failed');
    await board.locator('.done-row .card-open').click();
    await expect(board.locator('.detail')).toContainText('Two suites hang under Bun');
    await expect(board.getByRole('button', { name: 'Reopen' })).toBeVisible();
  });

  test('Stats draws labelled charts whose text keeps its size', async ({ board }) => {
    await board.getByRole('button', { name: 'Stats' }).click();
    await expect(board.locator('.chart-card h2')).toHaveText([
      'Open by stage',
      'Finished, last 7 days',
      'Open per project',
      'Open per assignee',
    ]);
    await expect(board.getByRole('img', { name: /^Open tasks by stage: backlog 4/ })).toBeVisible();
    await expect(board.getByRole('img', { name: /^Tasks finished per day/ })).toBeVisible();
    await expect(board.locator('.chart .c-done')).not.toHaveCount(0);
    await expect(board.locator('.chart .c-failed')).not.toHaveCount(0);
    const sizes = await board
      .locator('.bar-label, .bar-n, .col-label')
      .evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
    await expect(board.locator('.bar-label', { hasText: 'backlog' })).toBeVisible();
  });
});

test.describe('detail', () => {
  test('shows facts, safe Markdown, dependencies, artifacts and comments', async ({
    board,
    server,
  }) => {
    await openTask(board, server.ids.working);
    await expect(board).toHaveURL(new RegExp(`#/board/${server.ids.working}$`));
    const d = board.locator('.detail');
    await expect(d.locator('.stage.is-now')).toHaveText('implement');
    await expect(d.locator('.facts')).toContainText('alice');
    await expect(d.locator('.description h4')).toHaveText('Acceptance');
    await expect(d.locator('.description code').first()).toHaveText('Retry-After');
    await expect(d.locator('.description a', { hasText: 'RFC 6585' })).toHaveAttribute(
      'href',
      'https://www.rfc-editor.org/rfc/rfc6585',
    );
    await expect(d.locator('.description')).toContainText('<script>alert(1)</script> stays text.');
    expect(await board.locator('.detail script').count()).toBe(0);
    await expect(d.locator('.refs', { hasText: 'Blocks' })).toContainText(
      'Expose throttling metrics',
    );
    await d.locator('.artifact summary').click();
    await expect(d.locator('.artifact table td').first()).toHaveText('60');
    await expect(d.locator('.artifact pre')).toContainText("rateLimit({ window: '1m', max: 60 })");
    await expect(d.locator('.comment')).toHaveCount(2);
    await expect(d.locator('.description a', { hasText: 'Foo (bar)' })).toHaveAttribute(
      'href',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
    await expect(d.locator('.description')).toContainText('the alert link stays text.');
    expect(await d.locator('a[href^="javascript"]').count()).toBe(0);

    await d.locator('.refs .ref').click();
    await expect(board.locator('.detail-title')).toHaveText(
      'Expose throttling metrics on /metrics',
    );
    await expect(board.locator('.detail .hint')).toHaveText(
      `It moves on once #${server.ids.working} is done.`,
    );
    await expect(board.getByRole('button', { name: /Advance/ })).toHaveCount(0);
    await board.goBack();
    await expect(board.locator('.detail-title')).toHaveText(
      'Rate-limit the public search endpoint',
    );
    await board.keyboard.press('Escape');
    await expect(board.locator('.detail')).toHaveCount(0);
    await expect(board).toHaveURL(/#\/board$/);
  });

  test('a deep link opens the task', async ({ page, server }) => {
    await page.goto(`${server.url}#/board/${server.ids.parent}`);
    await expect(page.locator('.detail-title')).toHaveText('Onboarding flow redesign');
    await expect(page.locator('.refs', { hasText: 'Subtasks' }).locator('.ref')).toHaveCount(2);
  });

  test('an unclaimed task offers no Advance and says why', async ({ board, server }) => {
    await openTask(board, server.ids.unclaimed);
    await expect(board.locator('.detail .hint')).toContainText('Unclaimed');
    await expect(board.getByRole('button', { name: /Advance/ })).toHaveCount(0);
    await expect(board.getByRole('button', { name: 'Cancel task' })).toBeVisible();
  });
});

test.describe('stage actions', () => {
  test('advance moves the task to the next stage', async ({ board, server }) => {
    await openTask(board, server.ids.working);
    await board.getByRole('button', { name: 'Advance → test' }).click();
    await expect(board.locator('.notice')).toHaveText(`Advanced #${server.ids.working} to test.`);
    await expect(board.locator('.stage.is-now')).toHaveText('test');
    await expect(board.locator('[data-key="ask:complete"]')).toBeFocused();
    await expect(
      column(board, 'test').locator(`.card[data-id="${server.ids.working}"]`),
    ).toBeVisible();
    expect((await getTask(server, server.ids.working)).stage).toBe('test');
  });

  test('send back to an earlier stage with a reason', async ({ board, server }) => {
    await openTask(board, server.ids.working);
    await board.getByRole('button', { name: '← Send back' }).click();
    await board.locator('[data-key="form-stage"]').selectOption('spec');
    await board.getByRole('textbox', { name: /Why/ }).fill('Spec misses the tenant limits');
    await board.getByRole('button', { name: 'Send back', exact: true }).click();
    await expect(board.locator('.stage.is-now')).toHaveText('spec');
    const t = await getTask(server, server.ids.working);
    expect(t.stage).toBe('spec');
    expect(JSON.stringify(t.artifacts)).toContain('Spec misses the tenant limits');
    await expect(board.locator('.artifact summary').first()).toBeVisible();
  });

  test('complete wants a result, then closes the task', async ({ board, server }) => {
    await openTask(board, server.ids.working);
    await board.getByRole('button', { name: 'Complete' }).click();
    const submit = board.locator('[data-key="form-submit"]');
    await submit.click();
    await expect(board.locator('.action-form')).toBeVisible();
    await board.getByRole('textbox', { name: /Result/ }).fill('Limiter live behind a flag');
    await submit.click();
    await expect(board.locator('.notice')).toHaveText(`Completed #${server.ids.working}.`);
    await expect(board.locator('.result')).toContainText('Limiter live behind a flag');
    await expect(card(board, server.ids.working)).toHaveCount(0);
    expect((await getTask(server, server.ids.working)).status).toBe('completed');
  });

  test('fail records what went wrong', async ({ board, server }) => {
    await openTask(board, server.ids.working);
    await board.getByRole('button', { name: 'Fail' }).click();
    await board
      .getByRole('textbox', { name: /What went wrong/ })
      .fill('Redis not available in prod');
    await board.locator('[data-key="form-submit"]').click();
    await expect(board.locator('.result.tone-danger')).toContainText('Redis not available in prod');
    expect((await getTask(server, server.ids.working)).status).toBe('failed');
  });

  test('cancel, then reopen', async ({ board, server }) => {
    await openTask(board, server.ids.unclaimed);
    await board.getByRole('button', { name: 'Cancel task' }).click();
    await board.getByRole('textbox', { name: /Reason/ }).fill('Out of scope');
    await board.locator('[data-key="form-submit"]').click();
    await expect(board.getByRole('button', { name: 'Reopen' })).toBeVisible();
    await expect(board.locator('[data-key="ask-delete"]')).toBeFocused();
    expect((await getTask(server, server.ids.unclaimed)).status).toBe('cancelled');
    await board.getByRole('button', { name: 'Reopen' }).click();
    await expect(board.locator('.notice')).toHaveText(`Reopened #${server.ids.unclaimed}.`);
    expect((await getTask(server, server.ids.unclaimed)).status).toBe('pending');
    await expect(card(board, server.ids.unclaimed)).toBeVisible();
  });

  test('Never mind closes a form and keeps the task as it was', async ({ board, server }) => {
    await openTask(board, server.ids.working);
    await board.getByRole('button', { name: 'Fail' }).click();
    await board.getByRole('button', { name: 'Never mind' }).click();
    await expect(board.locator('.action-form')).toHaveCount(0);
    expect((await getTask(server, server.ids.working)).status).toBe('in_progress');
  });

  test('delete asks first, refuses a parent with open subtasks', async ({ board, server }) => {
    await openTask(board, server.ids.parent);
    await board.getByRole('button', { name: 'Delete' }).click();
    await expect(board.locator('.confirm')).toContainText('has open subtasks');
    await expect(board.getByRole('button', { name: /^Delete #/ })).toHaveCount(0);
    await board.getByRole('button', { name: 'Back', exact: true }).click();

    await openTask(board, server.ids.unclaimed);
    await board.getByRole('button', { name: 'Delete' }).click();
    await expect(board.locator('.confirm')).toContainText('There is no undo.');
    await board.getByRole('button', { name: `Delete #${server.ids.unclaimed}` }).click();
    await expect(board.locator('.notice')).toHaveText(`Deleted #${server.ids.unclaimed}.`);
    await expect(board.locator('.detail')).toHaveCount(0);
    await expect(board.locator('#main')).toBeFocused();
    await expect(card(board, server.ids.unclaimed)).toHaveCount(0);
    expect((await getTask(server, server.ids.unclaimed)).error).toMatch(/not found/i);
  });
});

test.describe('create and comment', () => {
  test('New task creates it and opens it', async ({ board, server }) => {
    await board.getByRole('button', { name: '+ New task' }).click();
    const dialog = board.getByRole('dialog', { name: 'New task' });
    await expect(dialog.getByRole('textbox', { name: 'Title' })).toBeFocused();
    await dialog.getByRole('textbox', { name: 'Title' }).fill('Write the dashboard docs');
    await dialog.getByRole('textbox', { name: /Description/ }).fill('With **screenshots**.');
    await dialog.getByRole('combobox', { name: 'Project' }).fill('docs');
    await dialog.getByRole('spinbutton', { name: 'Priority' }).fill('3');
    await dialog.getByRole('textbox', { name: 'Tags' }).fill('docs, ui');
    await dialog.getByRole('button', { name: 'Create task' }).click();
    await expect(dialog).toBeHidden();
    await expect(board.locator('.detail-title')).toHaveText('Write the dashboard docs');
    await expect(board.locator('.description strong')).toHaveText('screenshots');
    const id = Number((await board.locator('.detail .card-id').first().textContent())!.slice(1));
    const t = await getTask(server, id);
    expect(t).toMatchObject({
      project: 'docs',
      priority: 3,
      created_by: 'mathias',
      stage: 'backlog',
    });
    expect(JSON.parse(t.tags)).toEqual(['docs', 'ui']);
    await expect(column(board, 'backlog').locator(`.card[data-id="${id}"]`)).toBeVisible();
  });

  test('a comment posts as the dashboard user', async ({ board, server }) => {
    await openTask(board, server.ids.working);
    const box = board.getByRole('textbox', { name: 'Comment' });
    await box.fill('Looks good, ship it **today**');
    await board.getByRole('button', { name: 'Post comment' }).click();
    await expect(board.locator('.comment')).toHaveCount(3);
    await expect(board.locator('.comment').last().locator('strong')).toHaveText('today');
    await expect(box).toHaveValue('');
    const t = await getTask(server, server.ids.working);
    expect(t.comments.at(-1)).toMatchObject({
      agent_id: 'mathias',
      content: 'Looks good, ship it **today**',
    });
  });
});

test.describe('live', () => {
  test("another agent's changes show within seconds", async ({ board, server }) => {
    const made = await rest(server, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'Created by another agent', project: 'api' }),
    });
    await expect(card(board, made.id)).toBeVisible({ timeout: 6_000 });
    await rest(server, `/api/tasks/${server.ids.working}/stage`, {
      method: 'POST',
      body: JSON.stringify({ action: 'advance', by: 'alice' }),
    });
    await expect(
      column(board, 'test').locator(`.card[data-id="${server.ids.working}"]`),
    ).toBeVisible({
      timeout: 6_000,
    });
  });

  test('a second dashboard sees the first one act', async ({ board, server, browser }) => {
    const other = await browser.newPage();
    await other.goto(`${server.url}#/board/${server.ids.working}`);
    await expect(other.locator('.detail-title')).toBeVisible();
    await openTask(board, server.ids.working);
    await board.getByRole('textbox', { name: 'Comment' }).fill('Seen from the other tab?');
    await board.getByRole('button', { name: 'Post comment' }).click();
    await expect(other.locator('.comment').last()).toContainText('Seen from the other tab?', {
      timeout: 6_000,
    });
    await other.close();
  });

  test('the server going away shows Offline, and the board comes back', async ({
    board,
    server,
  }) => {
    await server.stop();
    await expect(board.locator('.server')).toHaveText('Offline', { timeout: 8_000 });
    await expect(board.getByRole('alert')).toContainText('The agent-tasks server is not reachable');
    await expect(board.getByRole('button', { name: '+ New task' })).toBeDisabled();
    await server.restart();
    await board.getByRole('button', { name: 'Try again' }).click();
    await expect(board.locator('.server')).toHaveText('Live');
    await expect(board.locator('.down')).toHaveCount(0);
    await expect(board.locator('.card')).toHaveCount(11);
  });
});

test.describe('layout and access', () => {
  test('phone width: no sideways scroll, stacked columns, detail fills the screen', async ({
    page,
    server,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(server.url);
    await expect(page.locator('.server')).toHaveText('Live');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const [a, b] = await page
      .locator('.column')
      .evaluateAll((cols) => cols.slice(0, 2).map((c) => c.getBoundingClientRect().top));
    expect(b).toBeGreaterThan(a);
    const tiles = await page
      .locator('.tile')
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
    expect(Math.abs(tiles.at(-1)! - tiles[0]! - (tiles[2]! - tiles[0]!))).toBeLessThan(2);
    await page.locator(`.card[data-id="${server.ids.working}"] .card-open`).click();
    const box = await page.locator('.panel').boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(370);
    await page.getByRole('button', { name: 'Close (Esc)' }).click();
    await expect(page.locator('.detail')).toHaveCount(0);
  });

  test('dark mode follows the system', async ({ browser, server }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(server.url);
    await expect(page.locator('.server')).toHaveText('Live');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g)!.map(Number);
    expect(r + g + b).toBeLessThan(120);
    await ctx.close();
  });

  test('dark mode: filled controls and pills keep AA contrast', async ({ browser, server }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(`${server.url}#/board/${server.ids.working}`);
    await page.getByRole('button', { name: 'Delete' }).click();
    const ratios = await page
      .locator('.btn.primary, .btn.danger, .stage.is-now, .column-empty, .tile-label')
      .evaluateAll((els) =>
        els.map((e) => {
          const lum = (c: string) => {
            const [r, g, b] = c
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map((v) => {
                const x = Number(v) / 255;
                return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
              });
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
          };
          let bg = e as Element | null;
          while (bg && /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(bg).backgroundColor))
            bg = bg.parentElement;
          const [a, b] = [
            lum(getComputedStyle(e).color),
            lum(getComputedStyle(bg!).backgroundColor),
          ];
          return [e.textContent, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)] as const;
        }),
      );
    expect(ratios.length).toBeGreaterThan(3);
    for (const [text, ratio] of ratios) expect(ratio, text ?? '').toBeGreaterThanOrEqual(4.5);
    await ctx.close();
  });

  test('keyboard: / to find, Tab to a card, Enter opens, Escape closes', async ({
    board,
    server,
  }) => {
    await board.keyboard.press('/');
    await expect(board.getByRole('searchbox', { name: 'Find tasks' })).toBeFocused();
    await board.keyboard.type('rate');
    const open = card(board, server.ids.working).locator('.card-open');
    await open.focus();
    await board.keyboard.press('Enter');
    await expect(board.locator('.detail-title')).toBeVisible();
    await expect(board.getByRole('button', { name: 'Close (Esc)' })).toBeFocused();
    await board.keyboard.press('Escape');
    await expect(board.locator('.detail')).toHaveCount(0);
    await expect(open).toBeFocused();
  });

  test('the page runs under its CSP and refuses to be framed', async ({ server }) => {
    const res = await fetch(server.url);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
