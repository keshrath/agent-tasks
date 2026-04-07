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
import { startDashboard, type DashboardServer } from './server.js';

const DASHBOARD_PORT = parseInt(process.env.AGENT_TASKS_PORT ?? '3422', 10);

const SERVER_INFO = readPackageMeta();

const INSTRUCTIONS =
  process.env.AGENT_TASKS_INSTRUCTIONS !== '0'
    ? '\n\n---\nPIPELINE: Tasks flow through stages: backlog → spec → plan → implement → test → review → done. ' +
      'Always advance tasks through stages (task_advance). Attach artifacts at each stage (task_add_artifact). ' +
      'Use task_next to pick up unblocked work. Add comments (task_comment) to discuss decisions.'
    : '';

const appContext = createContext();
const handleTool = createToolHandler(appContext);

let dashboard: DashboardServer | null = null;
let dashboardStarted = false;

function tryStartDashboard(): void {
  if (dashboardStarted) return;
  dashboardStarted = true;
  startDashboard(appContext, DASHBOARD_PORT)
    .then((dashboardServer) => {
      dashboard = dashboardServer;
    })
    .catch((err) => {
      process.stderr.write(
        '[agent-tasks] Dashboard start failed: ' +
          (err instanceof Error ? err.message : String(err)) +
          '\n',
      );
    });
}

startMcpServer({
  serverInfo: SERVER_INFO,
  tools,
  handleTool,
  onInitialize: tryStartDashboard,
  formatResult: (result) => JSON.stringify(result, null, 2) + INSTRUCTIONS,
  logLabel: 'agent-tasks',
});

function cleanup(): void {
  if (dashboard) dashboard.close();
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
