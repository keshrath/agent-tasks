/* global process, console */
// =============================================================================
// Builds the web UI into dist/ui/:
//   index.html + app.js + app.css   the dashboard the REST server serves at GET /
//   widget.html                     the MCP Apps widget, one self-contained file
//                                   (inline JS + CSS, no requests) for any host CSP
// Same views and stylesheet for both (src/ui/app.js, views/, styles.css).
// =============================================================================
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const OUT = join(here, '..', '..', 'dist', 'ui');

const zodEnglishOnly = {
  name: 'zod-english-only',
  setup(b) {
    b.onResolve({ filter: /\/locales\/index\.js$/ }, (a) =>
      /[\\/]zod[\\/]/.test(a.importer)
        ? { path: resolve(a.resolveDir, a.path), namespace: 'zod-locales' }
        : undefined,
    );
    b.onLoad({ filter: /.*/, namespace: 'zod-locales' }, (a) => ({
      contents: `export { default as en } from ${JSON.stringify(a.path.replace(/index\.js$/, 'en.js').replace(/\\/g, '/'))};`,
      resolveDir: dirname(a.path),
    }));
  },
};

async function bundle(entry) {
  const r = await build({
    entryPoints: [join(here, entry)],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2022',
    write: false,
    legalComments: 'none',
    plugins: [zodEnglishOnly],
  });
  return r.outputFiles[0].text;
}

export function css() {
  return readFileSync(join(here, 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232563eb'/%3E%3Crect x='7' y='7' width='5' height='18' rx='1.5' fill='white'/%3E%3Crect x='13.5' y='11' width='5' height='14' rx='1.5' fill='white' opacity='.85'/%3E%3Crect x='20' y='15' width='5' height='10' rx='1.5' fill='white' opacity='.7'/%3E%3C/svg%3E";

function page({ head, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>agent-tasks</title>
${head}
</head>
<body>
<div id="root" class="app"></div>
${body}
</body>
</html>
`;
}

export async function buildDashboard() {
  return {
    'index.html': page({
      head: `<link rel="icon" href="${FAVICON}">\n<link rel="stylesheet" href="app.css">\n<script src="app.js" defer></script>`,
      body: '',
    }),
    'app.js': await bundle('dashboard.js'),
    'app.css': css(),
  };
}

export async function buildWidget() {
  const js = await bundle('widget.js');
  const style = css();
  if (/<\/script/i.test(js) || /<\/style/i.test(style))
    throw new Error('unescaped closing tag in an inline asset');
  return page({ head: `<style>${style}</style>`, body: `<script>${js}</script>` });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(OUT, { recursive: true });
  const files = { ...(await buildDashboard()), 'widget.html': await buildWidget() };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(OUT, name), text);
  console.error(
    `ui: ${Object.entries(files)
      .map(([n, t]) => `${n} ${(t.length / 1024).toFixed(1)} KB`)
      .join(', ')}`,
  );
}
