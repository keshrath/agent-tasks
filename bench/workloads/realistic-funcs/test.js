// =============================================================================
// realistic-funcs test runner.
// Each function counts as ONE unit. PASSED_FNS=<csv of passing function names>
// =============================================================================

const passed = [];

function check(name, fn) {
  try {
    if (fn() === true) passed.push(name);
  } catch {
    /* fail silently — function not implemented or buggy */
  }
}

// ---------- parseCsv ----------
check('parseCsv', () => {
  const { parseCsv } = require('./csv.js');
  const out1 = parseCsv('a,b,c\n1,2,3\n4,5,6');
  if (out1.length !== 2) return false;
  if (out1[0].a !== '1' || out1[0].b !== '2' || out1[0].c !== '3') return false;
  if (out1[1].a !== '4' || out1[1].b !== '5' || out1[1].c !== '6') return false;

  const out2 = parseCsv('name,note\nalice,"hello, world"\nbob,plain');
  if (out2[0].note !== 'hello, world') return false;
  if (out2[1].note !== 'plain') return false;

  const out3 = parseCsv('q\n"he said ""hi"""');
  if (out3[0].q !== 'he said "hi"') return false;

  const out4 = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
  if (out4.length !== 2 || out4[1].b !== '4') return false;

  const out5 = parseCsv('a,b,c\n1,,3');
  if (out5[0].b !== '') return false;

  const out6 = parseCsv('1,2,3\n4,5,6', { header: ['x', 'y', 'z'] });
  if (out6[0].x !== '1' || out6[0].z !== '3') return false;
  if (out6.length !== 2) return false;

  return true;
});

// ---------- stringifyCsv ----------
check('stringifyCsv', () => {
  const { stringifyCsv } = require('./csv.js');
  const s1 = stringifyCsv([
    { a: '1', b: '2' },
    { a: '3', b: '4' },
  ]);
  if (s1 !== 'a,b\n1,2\n3,4\n' && s1 !== 'a,b\n1,2\n3,4') return false;

  const s2 = stringifyCsv([{ name: 'alice', note: 'hello, world' }]);
  if (!s2.includes('"hello, world"')) return false;

  const s3 = stringifyCsv([{ q: 'he said "hi"' }]);
  if (!s3.includes('"he said ""hi"""')) return false;

  const s4 = stringifyCsv([{ a: '1' }, { a: '2', b: '3' }]);
  // First row defines order; new keys append
  const lines = s4.trim().split('\n');
  if (lines[0] !== 'a,b' && lines[0] !== 'a,b,') return false;

  return true;
});

// ---------- diffObjects ----------
check('diffObjects', () => {
  const { diffObjects } = require('./diff.js');

  const d1 = diffObjects({ a: 1, b: 2 }, { a: 1, b: 2 });
  if (Object.keys(d1.added).length !== 0) return false;
  if (Object.keys(d1.removed).length !== 0) return false;
  if (Object.keys(d1.changed).length !== 0) return false;
  if (d1.unchanged.length !== 2) return false;

  const d2 = diffObjects({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 });
  if (d2.added.c !== 4) return false;
  if (Object.keys(d2.removed).length !== 0) return false;
  if (d2.changed.b.from !== 2 || d2.changed.b.to !== 3) return false;
  if (d2.unchanged[0] !== 'a') return false;

  const d3 = diffObjects({ x: 1, y: 2 }, { y: 2 });
  if (d3.removed.x !== 1) return false;

  const d4 = diffObjects({ a: NaN }, { a: NaN });
  if (Object.keys(d4.changed).length !== 0) return false;
  if (d4.unchanged[0] !== 'a') return false;

  const d5 = diffObjects({ a: null }, { a: undefined });
  if (Object.keys(d5.changed).length !== 1) return false;

  return true;
});

// ---------- renderTemplate ----------
check('renderTemplate', () => {
  const { renderTemplate } = require('./template.js');

  if (renderTemplate('hello {{name}}', { name: 'world' }) !== 'hello world') return false;
  if (renderTemplate('{{  name  }}', { name: 'x' }) !== 'x') return false;
  if (renderTemplate('hi {{missing}}!', {}) !== 'hi !') return false;
  if (renderTemplate('\\{{name}}', { name: 'x' }) !== '{{name}}') return false;
  if (renderTemplate('{{name | upper}}', { name: 'foo' }) !== 'FOO') return false;
  if (renderTemplate('{{name | trim | upper}}', { name: '  bar  ' }) !== 'BAR') return false;
  if (renderTemplate('{{n | length}}', { n: 'abc' }) !== '3') return false;
  if (renderTemplate("{{x | default('NA')}}", {}) !== 'NA') return false;
  if (renderTemplate("{{x | default('NA')}}", { x: 'real' }) !== 'real') return false;

  let threw = false;
  try {
    renderTemplate('{{name | bogus}}', { name: 'x' });
  } catch {
    threw = true;
  }
  if (!threw) return false;

  return true;
});

console.log(`PASSED_FNS=${passed.join(',')}`);
process.exit(passed.length === 4 ? 0 : 1);
