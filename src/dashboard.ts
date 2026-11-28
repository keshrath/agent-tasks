// =============================================================================
// agent-tasks — `npx agent-tasks dashboard [--no-open]`
//
// Prints the web dashboard's URL and opens it in the browser. When no
// agent-tasks process serves REST on the port yet, this one does until Ctrl+C
// (a running MCP process serves it otherwise: the dashboard lives on its REST
// server). The URL is built here from the port, never taken from an answer:
// on Windows it passes through cmd, which would run whatever follows an `&`.
// =============================================================================

import { spawn } from 'node:child_process';
import { createContext } from './context.js';
import { startRestServer } from './server.js';

/** Whether an agent-tasks REST server answers on `port`. */
async function isServed(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return ((await res.json()) as { status?: string }).status === 'ok';
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}

export async function dashboard(port: number, argv: string[]): Promise<void> {
  const isOpening = !argv.includes('--no-open');
  if (await isServed(port)) {
    const url = `http://127.0.0.1:${port}/`;
    process.stdout.write(`agent-tasks dashboard: ${url}\n`);
    if (isOpening) openBrowser(url);
    return;
  }
  const ctx = createContext();
  const server = await startRestServer(ctx, port).catch((err: NodeJS.ErrnoException) => {
    ctx.close();
    process.stderr.write(
      err.code === 'EADDRINUSE'
        ? `Port ${port} is taken by something that is not agent-tasks (AGENT_TASKS_PORT picks another).\n`
        : `Could not start the REST server: ${err.message}\n`,
    );
    process.exit(1);
  });
  const url = `http://127.0.0.1:${server.port}/`;
  process.stdout.write(
    `agent-tasks dashboard: ${url}  (served by this process; Ctrl+C stops it)\n`,
  );
  if (isOpening) openBrowser(url);
  const stop = () => {
    server.close();
    ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
