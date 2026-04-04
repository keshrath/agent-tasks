// =============================================================================
// agent-tasks — package.json metadata (name + version)
//
// Single source for MCP initialize and WebSocket payloads. Cached after first read.
// =============================================================================

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const thisDir = dirname(fileURLToPath(import.meta.url));

let cached: { name: string; version: string } | null = null;

export function readPackageMeta(): { name: string; version: string } {
  if (cached) return cached;
  try {
    const raw = readFileSync(join(thisDir, '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { name?: string; version?: string };
    cached = {
      name: typeof pkg.name === 'string' ? pkg.name : 'agent-tasks',
      version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    };
  } catch {
    cached = { name: 'agent-tasks', version: '0.0.0' };
  }
  return cached;
}
