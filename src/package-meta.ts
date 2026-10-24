// =============================================================================
// agent-tasks — package.json metadata (name + version)
//
// Read once from agent-tasks' own package.json (one level above dist/ and src/)
// so MCP initialize and REST /health always report the authoritative version.
// =============================================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

export interface PackageMeta {
  name: string;
  version: string;
}

let meta: PackageMeta | null = null;

export function readPackageMeta(): PackageMeta {
  if (meta) return meta;
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as Partial<PackageMeta>;
    meta = { name: pkg.name ?? 'agent-tasks', version: pkg.version ?? '0.0.0' };
  } catch {
    meta = { name: 'agent-tasks', version: '0.0.0' };
  }
  return meta;
}
