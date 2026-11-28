// =============================================================================
// The MCP Apps widget end to end: the built widget.html in a sandboxed iframe
// under an ext-apps AppBridge host, its tool calls answered by the real MCP
// server over a seeded scratch database. A task_list result draws the board,
// a task_get result the detail, and actions go back through the tools.
// =============================================================================

import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { seed, type Seeded } from './seed.js';
import { SCRATCH } from './server.js';
import { createContext, type AppContext } from '../../dist/context.js';
import { createMcpServer } from '../../dist/transport/mcp.js';
// @ts-expect-error -- plain ESM build script without type declarations
import { buildWidget } from '../../src/ui/build.mjs';

type Json = Record<string, unknown>;
let ctx: AppContext;
let ids: Seeded;
let dir: string;
let rpc: (method: string, params?: Json) => Promise<Json>;
let hostJs: string;
let widgetHtml: string;

test.beforeAll(async () => {
  hostJs = (
    await build({
      entryPoints: [join(import.meta.dirname, 'widget-host.js')],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      write: false,
    })
  ).outputFiles[0]!.text;
  widgetHtml = await buildWidget();
});

test.beforeEach(async () => {
  mkdirSync(SCRATCH, { recursive: true });
  dir = mkdtempSync(join(SCRATCH, 'widget-'));
  ids = seed(join(dir, 'tasks.db'));
  ctx = createContext({ path: join(dir, 'tasks.db') });
  const server = createMcpServer(ctx, { footer: true });
  const [client, side] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<number, (m: Json) => void>();
  let next = 1;
  client.onmessage = (m) => {
    const msg = m as Json;
    if (typeof msg.id === 'number') waiting.get(msg.id)?.(msg);
  };
  await server.connect(side);
  await client.start();
  rpc = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      void client.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    });
  await rpc('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'claude-desktop', version: '1' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
});

test.afterEach(() => {
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

const PAGE = (dark: boolean) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
body { margin: 0; padding: 16px; background: ${dark ? '#0b0d10' : '#eef0f3'}; }
#host { max-width: 760px; margin: auto; border-radius: 12px; overflow: hidden; background: ${dark ? '#16191e' : '#fff'}; }
iframe { display: block; width: 100%; border: 0; height: 200px; }
</style></head><body><div id="host"></div></body></html>`;

async function host(page: Page, tool: string, args: Json, theme = 'light') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.exposeFunction('__callTool', async (name: string, a: Json) => {
    const res = await rpc('tools/call', { name, arguments: a });
    return res.result;
  });
  await page.setContent(PAGE(theme === 'dark'));
  await page.evaluate(
    ([scenario, html]) => {
      const w = window as unknown as Json;
      w.__scenario = scenario;
      w.WIDGET_HTML = html;
    },
    [{ tool, args, theme }, widgetHtml] as const,
  );
  await page.addScriptTag({ content: hostJs, type: 'module' });
  await page.waitForSelector('body[data-ready="1"]');
  return { frame: page.frameLocator('iframe'), errors };
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __calls: Json[] }).__calls);

test('a task_list result draws the board, and a card opens its detail', async ({ page }) => {
  const { frame, errors } = await host(page, 'task_list', { project: 'api' });
  await expect(frame.locator('.column-head h2').first()).toHaveText('backlog');
  await expect(frame.locator('.card')).toHaveCount(4);
  await expect(frame.locator(`.card[data-id="${ids.working}"]`)).toContainText('alice');
  await frame.getByRole('button', { name: 'Done' }).click();
  await expect(frame.locator('.done-row').first()).toBeVisible();
  await frame.getByRole('button', { name: /^Board/ }).click();
  await frame.locator(`.card[data-id="${ids.working}"] .card-open`).click();
  await expect(frame.locator('.detail-title')).toHaveText('Rate-limit the public search endpoint');
  await expect(frame.locator('.description h4')).toHaveText('Acceptance');
  expect((await calls(page)).map((c) => c.name)).toContain('task_get');
  expect(errors).toEqual([]);
});

test('a task_get result draws the detail; Advance goes through task_stage', async ({ page }) => {
  const { frame, errors } = await host(page, 'task_get', { task_id: ids.working });
  await expect(frame.locator('.detail-title')).toHaveText('Rate-limit the public search endpoint');
  await expect(frame.getByRole('button', { name: 'Close (Esc)' })).toHaveCount(0);
  await frame.getByRole('button', { name: 'Advance → test' }).click();
  await expect(frame.locator('.stage.is-now')).toHaveText('test');
  expect(await calls(page)).toContainEqual({
    name: 'task_stage',
    arguments: { task_id: ids.working, action: 'advance', stage: 'test', from: 'implement' },
  });
  expect(ctx.tasks.getById(ids.working)!.stage).toBe('test');
  await frame.getByRole('textbox', { name: 'Comment' }).fill('From the chat');
  await frame.getByRole('button', { name: 'Post comment' }).click();
  await expect(frame.locator('.comment').last()).toContainText('From the chat');
  expect(ctx.comments.list(ids.working).at(-1)!.agent_id).toMatch(/^claude-desktop@/);
  expect(errors).toEqual([]);
});

test('a refused action says why inside the widget', async ({ page }) => {
  const { frame } = await host(page, 'task_get', { task_id: ids.working });
  await expect(frame.locator('.detail-title')).toBeVisible();
  ctx.tasks.advance(ids.working, 'test');
  await frame.getByRole('button', { name: 'Advance → test' }).click();
  await expect(frame.locator('.notice.tone-danger')).toContainText('moved to test meanwhile');
});

for (const theme of ['light', 'dark']) {
  test(`screenshots (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    const { frame } = await host(page, 'task_list', {}, theme);
    await expect(frame.locator('.card').first()).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SCRATCH, `widget-board-${theme}.png`), fullPage: true });
    await frame.locator(`.card[data-id="${ids.working}"] .card-open`).click();
    await expect(frame.locator('.detail-title')).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SCRATCH, `widget-detail-${theme}.png`), fullPage: true });
  });
}
