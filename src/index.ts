#!/usr/bin/env node

// =============================================================================
// agent-tasks — MCP server entry point
//
// Pipeline-driven task management for AI coding agents.
// Communicates via JSON-RPC 2.0 over stdio (Model Context Protocol) through
// agent-common's startMcpServer. formatResult appends a pipeline-instructions
// footer so AI clients are reminded of the stage lifecycle.
// =============================================================================

import { startMcpServer } from 'agent-common';
import { createContext } from './context.js';
import { readPackageMeta } from './package-meta.js';
import { tools, createToolHandler } from './transport/mcp.js';
import { serveRestWhenFree, type RestLeader } from './server.js';

const REST_PORT = parseInt(process.env.AGENT_TASKS_PORT ?? '3422', 10);

const SERVER_INFO = readPackageMeta();

const INSTRUCTIONS =
  process.env.AGENT_TASKS_INSTRUCTIONS !== '0'
    ? '\n\n---\nPIPELINE: Tasks flow through stages: backlog → spec → plan → implement → test → review → done. ' +
      'Always advance tasks through stages (task_stage action "advance"). Attach artifacts at each stage (task_artifact). ' +
      'Use task_list with next: true to pick up unblocked work. Discuss decisions with task_artifact type "comment".'
    : '';

const appContext = createContext();
const handleTool = createToolHandler(appContext);

let rest: RestLeader | null = null;

startMcpServer({
  serverInfo: SERVER_INFO,
  tools,
  handleTool,
  onInitialize: () => {
    rest ??= serveRestWhenFree(appContext, REST_PORT);
  },
  formatResult: (result) => JSON.stringify(result, null, 2) + INSTRUCTIONS,
  logLabel: 'agent-tasks',
});

function cleanup(): void {
  rest?.close();
  appContext.close();
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
