// =============================================================================
// Films parts of a real Claude Code session for the user manual. A Recorder
// samples the pseudo-terminal's screen while a scene plays; a Film replays the
// frames in a real xterm.js page (Playwright's Chromium) and writes a PNG still
// or an animated GIF, encoded in pure JS (gifenc + pngjs): one palette for the
// whole clip, and the pixels a frame leaves as they were are transparent, so a
// clip stays small. A crop keeps the pane (or any block of cells) alone.
// =============================================================================

import { writeFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from '@playwright/test';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { sleep, type ClaudeTerm } from './harness.js';
import { THEME, UNICODE_JS, XTERM_CSS, XTERM_JS, type Frame } from './render.js';

// gifenc is CommonJS without named exports Node can see.
const { GIFEncoder, applyPalette, quantize } = gifenc;

/** Cells to keep: columns [from, to) and rows [top, bottom). */
export interface Crop {
  from: number;
  to: number;
  top: number;
  bottom: number;
}

/** What a still or a clip replays: the terminal's size, its frames and what to keep of them. */
export interface Take {
  cols: number;
  rows: number;
  frames: Frame[];
  crop: Crop | null;
}

/**
 * The docked pane's cells: from its left border (the column most rows draw `│` in) to the
 * right edge, over the rows that border spans. Null when no pane is docked.
 */
export function paneCrop(t: ClaudeTerm): Crop | null {
  const lines = t
    .text()
    .split('\n')
    .map((l) => Array.from(l));
  const hits = new Map<number, number[]>();
  lines.forEach((cells, y) =>
    cells.forEach((c, x) => {
      if (c === '│') hits.set(x, [...(hits.get(x) ?? []), y]);
    }),
  );
  const [col, rows] = [...hits].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  if (col === undefined || !rows || rows.length < 10) return null;
  return { from: col, to: t.cols, top: Math.max(0, rows[0] - 1), bottom: rows.at(-1)! + 1 };
}

/** Lines about the account running the recording (usage limits), not about the pane. */
const NOISE = /You've used \d+% of your|\/usage-credits/;

/**
 * The screen as escape sequences, with the account's own notices blanked: each such line is
 * overwritten up to the pane's border (the whole line without a pane).
 */
export function capture(t: ClaudeTerm): string {
  let blank = '';
  t.text()
    .split('\n')
    .forEach((line, y) => {
      if (!NOISE.test(line)) return;
      const bar = Array.from(line).indexOf('│');
      blank += `\x1b[${y + 1};1H\x1b[0m${' '.repeat(bar > 0 ? bar : t.cols)}`;
    });
  return t.serialize() + blank;
}

/**
 * Samples the screen every `every` ms. A sample is kept once it has held for one more sample
 * (a screen caught halfway through a redraw never makes a frame) and differs from the last kept.
 */
export class Recorder {
  private frames: Frame[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private t0 = 0;

  constructor(
    private readonly t: ClaudeTerm,
    private readonly every = 15,
  ) {}

  start(): void {
    this.frames = [{ at: 0, data: capture(this.t) }];
    this.t0 = Date.now();
    let pending = '';
    this.timer = setInterval(() => {
      const data = capture(this.t);
      if (data === pending && this.frames.at(-1)!.data !== data)
        this.frames.push({ at: Date.now() - this.t0, data });
      pending = data;
    }, this.every);
  }

  /** Holds the last screen for `hold` ms, then stops; the frames played so far. */
  async stop(hold = 1_500): Promise<Frame[]> {
    await sleep(hold);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const data = capture(this.t);
    if (this.frames.at(-1)!.data !== data) this.frames.push({ at: Date.now() - this.t0, data });
    this.frames.push({ at: Date.now() - this.t0, data });
    return this.frames;
  }
}

/** Pads a crop with this much of the background, in pixels. */
const PAD = 10;

/** One xterm.js page in Chromium that draws frames and photographs them. */
export class Film {
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
  ) {}

  static async open(): Promise<Film> {
    const browser = await chromium.launch();
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    return new Film(browser, page);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  private async load(cols: number, rows: number): Promise<void> {
    await this.page.setViewportSize({
      width: Math.ceil(cols * 9) + 2 * PAD + 40,
      height: Math.ceil(rows * 18) + 2 * PAD + 40,
    });
    await this.page.setContent(
      `<!doctype html><html><head><style>${XTERM_CSS}
      body{margin:0;background:${THEME.background}}#t{display:inline-block;padding:${PAD}px}</style></head>
      <body><div id="t"></div><script>window.__name = (f) => f;</script></body></html>`,
    );
    await this.page.addScriptTag({ content: XTERM_JS });
    await this.page.addScriptTag({ content: UNICODE_JS });
    await this.page.evaluate(
      ([s, theme]) => {
        const w = window as unknown as {
          Terminal: new (o: object) => {
            open(el: HTMLElement): void;
            loadAddon(a: object): void;
            unicode: { activeVersion: string };
          };
          Unicode11Addon: { Unicode11Addon: new () => object };
          term: unknown;
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
        term.loadAddon(new w.Unicode11Addon.Unicode11Addon());
        term.unicode.activeVersion = '11';
        term.open(document.getElementById('t')!);
        w.term = term;
      },
      [{ cols, rows }, THEME] as const,
    );
  }

  private async draw(data: string): Promise<void> {
    await this.page.evaluate(
      (d) =>
        new Promise<void>((done) => {
          const term = (
            window as unknown as {
              term: { reset(): void; write(d: string, cb: () => void): void };
            }
          ).term;
          term.reset();
          term.write(d, () => requestAnimationFrame(() => done()));
        }),
      data,
    );
  }

  /** The page area a crop covers, in whole pixels (the whole terminal without one). */
  private async area(take: Take) {
    const r = await this.page.evaluate(() => {
      const b = document.querySelector('.xterm-screen')!.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    });
    const [cw, ch] = [r.w / take.cols, r.h / take.rows];
    const c = take.crop ?? { from: 0, to: take.cols, top: 0, bottom: take.rows };
    const x = Math.max(0, Math.floor(r.x + c.from * cw - PAD));
    const y = Math.max(0, Math.floor(r.y + c.top * ch - PAD));
    return {
      x,
      y,
      width: Math.ceil(r.x + c.to * cw + PAD) - x,
      height: Math.ceil(r.y + c.bottom * ch + 2) - y,
    };
  }

  /** One frame as RGBA pixels, photographed within `clip`. */
  private async pixels(
    data: string,
    clip: { x: number; y: number; width: number; height: number },
  ) {
    await this.draw(data);
    const png = PNG.sync.read(await this.page.screenshot({ clip }));
    return new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
  }

  /** The take's last frame as a PNG. Returns its size in bytes. */
  async still(file: string, take: Take): Promise<number> {
    await this.load(take.cols, take.rows);
    const clip = await this.area(take);
    await this.draw(take.frames.at(-1)!.data);
    const png = await this.page.screenshot({ clip, path: file });
    return png.length;
  }

  /**
   * The take as a looping GIF: each frame shown until the next one came (at least `min` ms,
   * at most `hold`), the last for `end` ms. Returns its size in bytes.
   */
  async gif(
    file: string,
    take: Take,
    { colors = 96, min = 80, hold = 1_800, end = 2_500 } = {},
  ): Promise<number> {
    await this.load(take.cols, take.rows);
    const clip = await this.area(take);
    const { width: w, height: h } = clip;
    const frames = take.frames;
    // One palette from a spread of frames, so a color means the same thing all clip long.
    const step = Math.max(1, Math.floor(frames.length / 12));
    const picks = frames.filter((_, i) => i % step === 0 || i === frames.length - 1);
    const all = new Uint8Array(picks.length * w * h * 4);
    for (const [i, f] of picks.entries()) all.set(await this.pixels(f.data, clip), i * w * h * 4);
    const palette = quantize(all, colors);
    const clear = palette.length;
    const table = [...palette, [255, 0, 255]];

    // A frame is written once the next one differs: one drawn the same (after the palette)
    // only lengthens it. After the first, what a frame leaves as it was is transparent.
    const gif = GIFEncoder();
    let written: Uint8Array | null = null;
    let pending: { index: Uint8Array; delay: number } | null = null;
    const flush = () => {
      if (!pending) return;
      const { index, delay } = pending;
      if (!written) gif.writeFrame(index, w, h, { palette: table, delay, repeat: 0 });
      else {
        const diff = index.slice();
        for (let p = 0; p < diff.length; p++) if (diff[p] === written[p]) diff[p] = clear;
        gif.writeFrame(diff, w, h, {
          delay,
          transparent: true,
          transparentIndex: clear,
          dispose: 1,
        });
      }
      written = index;
    };
    for (const [i, f] of frames.entries()) {
      const index = applyPalette(await this.pixels(f.data, clip), palette);
      const next = frames[i + 1];
      const delay = next ? Math.min(hold, Math.max(min, next.at - f.at)) : end;
      if (pending && pending.index.every((v, p) => v === index[p]))
        pending.delay = next ? Math.min(hold, pending.delay + delay) : end;
      else {
        flush();
        pending = { index, delay };
      }
    }
    flush();
    gif.finish();
    const bytes = gif.bytes();
    writeFileSync(file, bytes);
    return bytes.length;
  }
}
