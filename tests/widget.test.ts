// =============================================================================
// The MCP Apps widget: the contract a host sees (tool _meta, the resource and
// its mime type against the ext-apps constants), the data the widget reads from
// real results of every widget tool and the view it picks for each, and the
// build (one self-contained HTML document, no HTML-string DOM in the sources).
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from '@modelcontextprotocol/server';
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server';
import { createMcpServer } from '../src/transport/mcp.js';
import { WIDGET_MIME, WIDGET_TOOLS, WIDGET_URI } from '../src/transport/widget.js';
import type { AppContext } from '../src/context.js';
import { createTestContext } from './helpers.js';
// @ts-expect-error -- plain browser ESM without type declarations
import { resultOf, viewOf } from '../src/ui/lib/view.js';
// @ts-expect-error -- plain ESM build script without type declarations
import { buildDashboard, buildWidget } from '../src/ui/build.mjs';

type Json = Record<string, unknown>;
interface Result {
  content: { type: string; text: string }[];
  structuredContent?: Json;
  isError?: boolean;
}

let ctx: AppContext;
let client: InMemoryTransport;
let nextId = 1;
const waiting = new Map<number, (msg: Json) => void>();

function rpc(method: string, params?: Json): Promise<Json> {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    void client.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  });
}

async function call(name: string, args: Json = {}): Promise<Result> {
  return (await rpc('tools/call', { name, arguments: args })).result as Result;
}

beforeEach(async () => {
  ctx = createTestContext();
  const server = createMcpServer(ctx, {});
  const [c, s] = InMemoryTransport.createLinkedPair();
  client = c;
  client.onmessage = (msg: JSONRPCMessage) => {
    const m = msg as Json;
    if (typeof m.id === 'number') waiting.get(m.id)?.(m);
  };
  await server.connect(s);
  await client.start();
  await rpc('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
});

afterEach(async () => {
  await client.close();
  ctx.close();
});

describe('host contract', () => {
  it('pins the ext-apps mime type and meta key', () => {
    expect(WIDGET_MIME).toBe(RESOURCE_MIME_TYPE);
    expect(RESOURCE_URI_META_KEY).toBe('ui/resourceUri');
  });

  it('points the widget tools, and only those, at the widget', async () => {
    const { tools } = (await rpc('tools/list')).result as {
      tools: { name: string; _meta?: Json }[];
    };
    for (const t of tools) {
      if (WIDGET_TOOLS.has(t.name))
        expect(t._meta, t.name).toEqual({
          ui: { resourceUri: WIDGET_URI },
          [RESOURCE_URI_META_KEY]: WIDGET_URI,
        });
      else expect(t._meta, t.name).toBeUndefined();
    }
    expect([...WIDGET_TOOLS].sort()).toEqual(['task_create', 'task_get', 'task_list']);
  });

  it('lists and serves the built widget as the one resource', async () => {
    const { resources } = (await rpc('resources/list')).result as { resources: Json[] };
    expect(resources).toMatchObject([{ uri: WIDGET_URI, mimeType: WIDGET_MIME }]);
    const read = (await rpc('resources/read', { uri: WIDGET_URI })).result as {
      contents: { uri: string; mimeType: string; text: string }[];
    };
    expect(read.contents[0]).toMatchObject({ uri: WIDGET_URI, mimeType: WIDGET_MIME });
    expect(read.contents[0]!.text.startsWith('<!doctype html>')).toBe(true);
    const missing = await rpc('resources/read', { uri: 'ui://agent-tasks/nope' });
    expect(missing.error).toBeDefined();
  });
});

describe('the data the widget reads and the view it draws', () => {
  const data = async (name: string, args: Json): Promise<Json> => resultOf(await call(name, args));

  it('task_list (plain, filtered, searched) draws the board', async () => {
    await call('task_create', { title: 'First', project: 'p' });
    await call('task_create', { title: 'Second searchable' });
    for (const args of [{}, { project: 'p' }, { query: 'searchable' }]) {
      const sc = await data('task_list', args);
      expect(Array.isArray(sc.tasks), JSON.stringify(args)).toBe(true);
      expect(viewOf(sc)).toBe('board');
    }
  });

  it('task_get, task_create and task_list next draw one task', async () => {
    const created = await data('task_create', { title: 'One' });
    expect(viewOf(created)).toBe('task');
    const id = created.id as number;
    const got = await data('task_get', { task_id: id, include: ['subtasks', 'comments'] });
    expect(got).toMatchObject({ id, title: 'One', gate_needs: null });
    expect(viewOf(got)).toBe('task');
    expect(viewOf(await data('task_list', { next: true }))).toBe('task');
  });

  it('a message result draws nothing', async () => {
    const none = await data('task_list', { next: true });
    expect(none).toEqual({ message: 'No available tasks.' });
    expect(viewOf(none)).toBeNull();
  });

  it('no structuredContent: the model reads the text, footer and all', async () => {
    for (const [name, args] of [
      ['task_create', { title: 'x' }],
      ['task_list', {}],
      ['task_get', { task_id: 999 }],
    ] as const) {
      const res = await call(name, args);
      expect(res.structuredContent, name).toBeUndefined();
      if (!res.isError)
        expect(res.content[0]!.text).toContain('PIPELINE: Tasks flow through stages');
    }
  });
});

describe('build', () => {
  const SRC = join(import.meta.dirname, '..', 'src', 'ui');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? sources(p) : p.endsWith('.js') ? [p] : [];
    });

  it('the widget is one self-contained HTML document', async () => {
    const html: string = await buildWidget();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import/i);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html.length).toBeLessThan(600 * 1024);
  }, 30_000);

  it('the dashboard loads only its own script and stylesheet', async () => {
    const files: Record<string, string> = await buildDashboard();
    expect(Object.keys(files).sort()).toEqual(['app.css', 'app.js', 'index.html']);
    expect(files['index.html']).toContain('<script src="app.js" defer></script>');
    expect(files['index.html']).not.toMatch(/<script>|<style>|(src|href)="https?:/);
  }, 30_000);

  it('the UI sources never build DOM from HTML strings', () => {
    for (const f of sources(SRC)) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write|new Function|eval\(/,
      );
    }
  });
});
