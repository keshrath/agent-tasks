// =============================================================================
// agent-tasks — package.json metadata (name + version)
//
// Thin wrapper around agent-common's readPackageMeta, locked to agent-tasks'
// own package.json so MCP initialize and WebSocket payloads always read the
// authoritative version.
// =============================================================================

import { readPackageMeta as readKitPackageMeta, type PackageMeta } from 'agent-common';

export function readPackageMeta(): PackageMeta {
  return readKitPackageMeta({
    importMetaUrl: import.meta.url,
    fallbackName: 'agent-tasks',
    fallbackVersion: '0.0.0',
  });
}
