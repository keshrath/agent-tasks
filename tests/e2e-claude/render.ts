// =============================================================================
// Renders the suite's screen captures (<label>.ansi: the xterm buffer
// serialized by @xterm/addon-serialize) to <label>.png in a real xterm.js page
// with a dark theme, through Playwright's Chromium.
// =============================================================================

import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const XTERM_JS = readFileSync(require.resolve('@xterm/xterm/lib/xterm.js'), 'utf8');
const XTERM_CSS = readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8');

const THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#1e1e2e',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};

/** Renders every .ansi capture in `dir` (or just `labels`) to a PNG beside it. */
export async function renderShots(dir: string, labels?: string[]): Promise<string[]> {
  const todo =
    labels ??
    readdirSync(dir)
      .filter((f) => f.endsWith('.ansi'))
      .map((f) => f.slice(0, -5));
  const browser = await chromium.launch();
  const written: string[] = [];
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const label of todo) {
      const shot = JSON.parse(readFileSync(join(dir, `${label}.ansi`), 'utf8')) as {
        cols: number;
        rows: number;
        data: string;
      };
      await page.setContent(
        `<!doctype html><html><head><style>${XTERM_CSS}
        body{margin:0;background:${THEME.background}}#t{display:inline-block;padding:12px}</style></head>
        <body><div id="t"></div></body></html>`,
      );
      await page.addScriptTag({ content: XTERM_JS });
      await page.evaluate(
        ([s, theme]) =>
          new Promise<void>((done) => {
            const w = window as unknown as {
              Terminal: new (o: object) => {
                open(el: HTMLElement): void;
                write(d: string, cb: () => void): void;
              };
            };
            const term = new w.Terminal({
              cols: s.cols,
              rows: s.rows,
              theme,
              fontFamily: 'Cascadia Mono, Consolas, monospace',
              fontSize: 14,
              cursorBlink: false,
              allowProposedApi: true,
            });
            term.open(document.getElementById('t')!);
            term.write(s.data, () => setTimeout(done, 100));
          }),
        [shot, THEME] as const,
      );
      const file = join(dir, `${label}.png`);
      await page.locator('#t').screenshot({ path: file });
      written.push(file);
    }
  } finally {
    await browser.close();
  }
  return written;
}

/** One screen of a recording: when it appeared (ms from the start) and its escape sequences. */
export type Frame = { at: number; data: string };
/** A caption shown from `at` (ms) until the next one. */
export type Caption = { at: number; text: string };

/**
 * Films a recording as a WebM: a page replays the frames in a real xterm.js at their
 * own pace under a caption bar, and Playwright records the page. Returns the file.
 */
export async function renderVideo(
  file: string,
  size: { cols: number; rows: number },
  frames: Frame[],
  captions: Caption[],
): Promise<string> {
  const width = Math.ceil(size.cols * 8.43) + 24;
  const height = Math.ceil(size.rows * 17) + 24 + 64;
  const dir = join(file, '..', `.video-${Date.now()}`);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      recordVideo: { dir, size: { width, height } },
    });
    const page = await context.newPage();
    await page.setContent(
      `<!doctype html><html><head><style>${XTERM_CSS}
      body{margin:0;background:${THEME.background};font-family:'Segoe UI',system-ui,sans-serif}
      #t{padding:12px}
      #c{height:64px;box-sizing:border-box;padding:0 20px;display:flex;align-items:center;
         background:#313244;color:#f5e0dc;font-size:20px;font-weight:600;letter-spacing:.2px}</style></head>
      <body><div id="c"></div><div id="t"></div>
      <script>window.__name = (f) => f; /* tsx's keepNames helper, used inside evaluate */</script>
      </body></html>`,
    );
    await page.addScriptTag({ content: XTERM_JS });
    const total = (frames.at(-1)?.at ?? 0) + 3_000;
    await page.evaluate(
      ([fs, cs, theme, s]) =>
        new Promise<void>((done) => {
          const w = window as unknown as {
            Terminal: new (o: object) => {
              open(el: HTMLElement): void;
              reset(): void;
              write(d: string): void;
            };
          };
          const term = new w.Terminal({
            cols: s.cols,
            rows: s.rows,
            theme,
            fontFamily: 'Cascadia Mono, Consolas, monospace',
            fontSize: 14,
            cursorBlink: false,
            allowProposedApi: true,
          });
          term.open(document.getElementById('t')!);
          const caption = document.getElementById('c')!;
          const start = performance.now();
          let f = 0;
          let c = 0;
          const tick = () => {
            const now = performance.now() - start;
            while (f < fs.length && fs[f].at <= now) {
              term.reset();
              term.write(fs[f].data);
              f += 1;
            }
            while (c < cs.length && cs[c].at <= now) caption.textContent = cs[c++].text;
            if (now < s.total) requestAnimationFrame(tick);
            else done();
          };
          tick();
        }),
      [frames, captions, THEME, { ...size, total }] as const,
    );
    await context.close();
    const video = page.video();
    if (!video) throw new Error('no video recorded');
    await video.saveAs(file);
  } finally {
    await browser.close();
  }
  rmSync(dir, { recursive: true, force: true });
  return file;
}
