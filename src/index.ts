#!/usr/bin/env node

// =============================================================================
// agent-tasks — MCP server entry point
//
// Pipeline-driven task management for AI coding agents, over stdio with the
// official MCP SDK. Once a client has initialized, this process also serves
// the REST API for the /pipeline pane, or keeps trying to take the port over.
// The client closing stdin ends it, so the port passes to a live session.
// =============================================================================

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createContext } from './context.js';
import { createMcpServer } from './transport/mcp.js';
import { serveRestWhenFree, type RestLeader } from './server.js';

const REST_PORT = parseInt(process.env.AGENT_TASKS_PORT ?? '3422', 10);

const appContext = createContext();
let rest: RestLeader | null = null;

const server = createMcpServer(appContext, {
  footer: process.env.AGENT_TASKS_INSTRUCTIONS !== '0',
  onInitialized: () => {
    rest ??= serveRestWhenFree(appContext, REST_PORT);
  },
});
server.onclose = () => process.exit(0);
await server.connect(new StdioServerTransport());

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('exit', () => {
  rest?.close();
  appContext.close();
});
