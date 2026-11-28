// =============================================================================
// A real REST server for the dashboard e2e: the built dist/server.js on a free
// port over a seeded scratch database (never the live :3422 or the live DB).
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { seed, type Seeded } from './seed.js';

const ROOT = join(import.meta.dirname, '..', '..');
export const SCRATCH = join(homedir(), '.claude', 'tmp', 'at-web');

export interface TestServer {
  url: string;
  port: number;
  ids: Seeded;
  dbPath: string;
  stop(): Promise<void>;
  /** Starts the server again on the same port and database (after stop). */
  restart(): Promise<void>;
}

function listen(dbPath: string, port: number): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(ROOT, 'dist', 'server.js'), '--port', String(port), '--db', dbPath],
      {
        env: {
          ...process.env,
          AGENT_COMM_URL: 'http://127.0.0.1:1',
          AGENT_KNOWLEDGE_URL: 'http://127.0.0.1:1',
          AGENT_TASKS_USER: 'mathias',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let err = '';
    child.stderr!.on('data', (d: Buffer) => {
      err += d.toString();
      const m = err.match(/REST API: http:\/\/localhost:(\d+)/);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${err}`)));
  });
}

export async function startServer(): Promise<TestServer> {
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH, 'e2e-'));
  const dbPath = join(dir, 'tasks.db');
  const ids = seed(dbPath);
  let { child, port } = await listen(dbPath, 0);
  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill();
    });
  return {
    get url() {
      return `http://127.0.0.1:${port}/`;
    },
    get port() {
      return port;
    },
    ids,
    dbPath,
    stop,
    async restart() {
      ({ child, port } = await listen(dbPath, port));
    },
  };
}

export async function disposeServer(s: TestServer): Promise<void> {
  await s.stop();
  rmSync(join(s.dbPath, '..'), { recursive: true, force: true });
}
