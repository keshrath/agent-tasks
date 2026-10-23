// Release manifests: CI publishes npm first, then the MCP Registry, so a
// manifest the registry rejects must fail here, before anything is published.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

describe('release manifests', () => {
  const pkg = read('package.json');
  const server = read('server.json') as {
    version: string;
    description: string;
    packages: Array<{ version: string }>;
  };

  it('keep every version file on the package version', () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages.map((p) => p.version)).toEqual([pkg.version]);
    expect(read('plugin/.claude-plugin/plugin.json').version).toBe(pkg.version);
  });

  it('pin the plugin MCP server to the package major', () => {
    const mcp = read('plugin/.mcp.json') as {
      mcpServers: Record<string, { args: string[] }>;
    };
    const major = String(pkg.version).split('.')[0];
    expect(mcp.mcpServers['agent-tasks'].args).toContain(`agent-tasks@^${major}`);
  });

  it('server.json description fits the MCP Registry limit (100 chars)', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
