#!/usr/bin/env node

// =============================================================================
// agent-tasks — MCP server entry point
//
// Pipeline-driven task management for AI coding agents.
// Communicates via JSON-RPC 2.0 over stdio (Model Context Protocol).
// =============================================================================

import { createInterface } from 'readline';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createContext } from './context.js';
import { tools, createToolHandler } from './transport/mcp.js';
import { startDashboard, type DashboardServer } from './server.js';
import type { JsonRpcRequest, JsonRpcResponse } from './types.js';

const __dirname_index = dirname(fileURLToPath(import.meta.url));
const pkgVersion: string = JSON.parse(
  readFileSync(join(__dirname_index, '..', 'package.json'), 'utf8'),
).version;

const DASHBOARD_PORT = parseInt(process.env.AGENT_TASKS_PORT ?? '3422', 10);

const SERVER_INFO = { name: 'agent-tasks', version: pkgVersion };
const CAPABILITIES = { tools: {} };

const INSTRUCTIONS =
  process.env.AGENT_TASKS_INSTRUCTIONS !== '0'
    ? '\n\n---\nPIPELINE: Tasks flow through stages: backlog → spec → plan → implement → test → review → done. ' +
      'Always advance tasks through stages (task_advance). Attach artifacts at each stage (task_add_artifact). ' +
      'Use task_next to pick up unblocked work. Add comments (task_comment) to discuss decisions.'
    : '';

function send(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function main() {
  const ctx = createContext();
  const handleTool = createToolHandler(ctx);
  let dashboard: DashboardServer | null = null;
  let dashboardStarted = false;

  function tryStartDashboard(): void {
    if (dashboardStarted) return;
    dashboardStarted = true;
    startDashboard(ctx, DASHBOARD_PORT)
      .then((d) => {
        dashboard = d;
      })
      .catch(() => {
        /* port in use — another instance is serving the dashboard */
      });
  }

  function makeToolResponse(id: number | string, result: unknown): JsonRpcResponse {
    const text = JSON.stringify(result, null, 2) + INSTRUCTIONS;
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text }] },
    };
  }

  function makeToolError(id: number | string, err: unknown): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      },
    };
  }

  function handleRequest(request: JsonRpcRequest): JsonRpcResponse | null {
    const { method, params, id } = request;

    switch (method) {
      case 'initialize':
        tryStartDashboard();
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: SERVER_INFO,
            capabilities: CAPABILITIES,
          },
        };

      case 'notifications/initialized':
        return null;

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools } };

      case 'tools/call': {
        const toolName = (params as { name: string }).name;
        const toolArgs = (params as { arguments?: Record<string, unknown> }).arguments || {};
        try {
          const result = handleTool(toolName, toolArgs);
          if (result && typeof result === 'object' && 'then' in result) {
            (result as Promise<unknown>)
              .then((resolved) => send(makeToolResponse(id, resolved)))
              .catch((err) => send(makeToolError(id, err)));
            return null;
          }
          return makeToolResponse(id, result);
        } catch (err) {
          return makeToolError(id, err);
        }
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      const response = handleRequest(request);
      if (response) send(response);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
  });

  // --- Graceful shutdown ---
  function cleanup() {
    if (dashboard) dashboard.close();
    ctx.close();
  }
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('exit', cleanup);
}

main();
