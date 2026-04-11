#!/usr/bin/env node

// =============================================================================
// agent-tasks setup script
//
// Configures an MCP-compatible AI agent to use agent-tasks.
// Currently supports: Claude Code (auto-detected via ~/.claude.json)
//
// What it does:
// - Builds the project if dist/ is missing
// - Registers the MCP server in the agent's config
// - Adds lifecycle hooks for Claude Code (pipeline enforcer, todowrite
//   bridge, session start, task cleanup on start/stop)
// - Adds permission for mcp__agent-tasks__* tools
//
// Usage: node scripts/setup.js [--agent claude|generic]
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(join(__dirname, '..'));
const HOME = homedir();
const CLAUDE_JSON = join(HOME, '.claude.json');
const SETTINGS_JSON = join(HOME, '.claude', 'settings.json');

const AGENT_FLAG = process.argv.find((_a, i, arr) => arr[i - 1] === '--agent') ?? 'auto';
const IS_CLAUDE = AGENT_FLAG === 'claude' || (AGENT_FLAG === 'auto' && existsSync(CLAUDE_JSON));

console.log('agent-tasks setup\n');
console.log(`Agent type: ${IS_CLAUDE ? 'Claude Code' : 'Generic (manual MCP config)'}`);

// ---------------------------------------------------------------------------
// Build if needed
// ---------------------------------------------------------------------------

if (!existsSync(join(PROJECT_DIR, 'dist', 'index.js'))) {
  console.log('Building agent-tasks...');
  execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'inherit' });
  console.log('');
}

// ---------------------------------------------------------------------------
// Register MCP server
// ---------------------------------------------------------------------------

const distPath = join(PROJECT_DIR, 'dist', 'index.js');

console.log('Registering MCP server...');
if (IS_CLAUDE && existsSync(CLAUDE_JSON)) {
  const config = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'));
  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers['agent-tasks'] = {
    type: 'stdio',
    command: 'node',
    args: [distPath],
    env: {},
  };

  writeFileSync(CLAUDE_JSON, JSON.stringify(config, null, 2));
  console.log(`  Added agent-tasks MCP server → ${distPath}`);
} else {
  console.log('  Add this to your MCP client config:');
  console.log('  {');
  console.log('    "mcpServers": {');
  console.log('      "agent-tasks": {');
  console.log('        "command": "node",');
  console.log(`        "args": ["${distPath.replace(/\\/g, '/')}"]`);
  console.log('      }');
  console.log('    }');
  console.log('  }');
}

// ---------------------------------------------------------------------------

if (!IS_CLAUDE) {
  console.log(`
Setup complete!

Start the dashboard:  node dist/server.js
MCP server (stdio):   node dist/index.js
Dashboard URL:        http://localhost:3422
`);
  process.exit(0);
}

console.log('Configuring Claude Code hooks...');
if (!existsSync(SETTINGS_JSON)) {
  console.log('  Warning: settings.json not found. Configure hooks manually.');
  process.exit(0);
}

const settings = JSON.parse(readFileSync(SETTINGS_JSON, 'utf-8'));

if (!settings.permissions) settings.permissions = {};
if (!settings.permissions.allow) settings.permissions.allow = [];
if (!settings.permissions.allow.includes('mcp__agent-tasks__*')) {
  settings.permissions.allow.push('mcp__agent-tasks__*');
  console.log('  Added mcp__agent-tasks__* permission');
}

if (!settings.hooks) settings.hooks = {};

const hookDir = join(PROJECT_DIR, 'scripts', 'hooks');

function addUnmatchedHook(eventName, marker, command, timeout = 10) {
  if (!settings.hooks[eventName]) settings.hooks[eventName] = [];
  const groups = settings.hooks[eventName];
  const existing = groups.find(
    (g) => g.hooks && g.hooks.some((h) => h.command && h.command.includes(marker)),
  );
  if (existing) {
    console.log(`  ${eventName} (${marker}): already configured`);
    return;
  }
  if (groups.length > 0 && groups[0].hooks && !groups[0].matcher) {
    groups[0].hooks.push({ type: 'command', command, timeout });
  } else {
    groups.push({ hooks: [{ type: 'command', command, timeout }] });
  }
  console.log(`  ${eventName}: added ${marker} hook`);
}

function addMatchedHook(eventName, matcher, marker, command, timeout = 5) {
  if (!settings.hooks[eventName]) settings.hooks[eventName] = [];
  const groups = settings.hooks[eventName];
  const existing = groups.find(
    (g) =>
      g.matcher === matcher &&
      g.hooks &&
      g.hooks.some((h) => h.command && h.command.includes(marker)),
  );
  if (existing) {
    console.log(`  ${eventName} (${matcher}:${marker}): already configured`);
    return;
  }
  groups.push({ matcher, hooks: [{ type: 'command', command, timeout }] });
  console.log(`  ${eventName} (${matcher}): added ${marker} hook`);
}

// SessionStart: dashboard banner + stale task cleanup
addUnmatchedHook(
  'SessionStart',
  'session-start.js',
  `node "${join(hookDir, 'session-start.js')}"`,
  5,
);
addUnmatchedHook(
  'SessionStart',
  'task-cleanup-start.js',
  `node "${join(hookDir, 'task-cleanup-start.js')}"`,
  10,
);

// UserPromptSubmit: pipeline enforcer
addUnmatchedHook(
  'UserPromptSubmit',
  'pipeline-enforcer.mjs',
  `node "${join(hookDir, 'pipeline-enforcer.mjs')}"`,
  10,
);

// PreToolUse (TodoWrite): bridge todos into the pipeline
addMatchedHook(
  'PreToolUse',
  'TodoWrite',
  'todowrite-bridge.mjs',
  `node "${join(hookDir, 'todowrite-bridge.mjs')}"`,
  5,
);

// Stop/SubagentStop: fail orphaned tasks
addUnmatchedHook(
  'Stop',
  'task-cleanup-stop.js',
  `node "${join(hookDir, 'task-cleanup-stop.js')}"`,
  10,
);
addUnmatchedHook(
  'SubagentStop',
  'task-cleanup-stop.js',
  `node "${join(hookDir, 'task-cleanup-stop.js')}"`,
  10,
);

writeFileSync(SETTINGS_JSON, JSON.stringify(settings, null, 2));
console.log('  Saved settings.json');

console.log(`
Setup complete!

Restart Claude Code to load the new MCP server. Every session will now:
  - Show the pipeline dashboard URL on start (SessionStart hook)
  - Auto-fail tasks orphaned by dead sessions (task-cleanup-start)
  - Enforce the "no work without a claimed task" rule (pipeline-enforcer)
  - Mirror Claude Code's TodoWrite todos into the pipeline (todowrite-bridge)
  - Auto-fail tasks still assigned when the session stops (task-cleanup-stop)

Dashboard: http://localhost:3422 (auto-starts on first MCP connection)
See docs/hooks.md for hook details and docs/SETUP.md for manual configuration.
`);
