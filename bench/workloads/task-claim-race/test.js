/* eslint-disable */
// DO NOT EDIT — test harness for the algos-6 workload. `node test.js`. Exit 0
// only when ALL functions pass. Emits PASSED_FNS=fn1,fn2,... for the bench
// driver to compute "unique units completed".

const tasks = [
  {
    fn: 'parseRow',
    file: './csv-parse.js',
    cases: [
      [['a,b,c'], ['a', 'b', 'c']],
      [['"a,b",c'], ['a,b', 'c']],
      [['"he said ""hi"""'], ['he said "hi"']],
      [['a,,b'], ['a', '', 'b']],
      [[''], ['']],
      [['"x","y","z"'], ['x', 'y', 'z']],
      [['a,"b,c,d",e'], ['a', 'b,c,d', 'e']],
      [['"""quoted"""'], ['"quoted"']],
    ],
    eq: (a, b) =>
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => v === b[i]),
  },
  {
    fn: 'formatNumber',
    file: './format-number.js',
    cases: [
      [[1234567.891, 2, ','], '1,234,567.89'],
      [[0, 0, ','], '0'],
      [[-1234.5, 0, '.'], '-1.235'],
      [[999, 2, ','], '999.00'],
      [[1000, 0, ','], '1,000'],
      [[-0.5, 0, ','], '-1'],
      [[1.005, 2, ','], '1.01'],
      [[1234567, 0, ' '], '1 234 567'],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'wordWrap',
    file: './word-wrap.js',
    cases: [
      [['the quick brown fox', 10], 'the quick\nbrown fox'],
      [['hello world', 5], 'hello\nworld'],
      [['supercalifragilistic is long', 5], 'supercalifragilistic\nis\nlong'],
      [['', 10], ''],
      [['a b c d e', 3], 'a b\nc d\ne'],
      [['one two three four', 8], 'one two\nthree\nfour'],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'toRoman',
    file: './roman.js',
    cases: [
      [[1], 'I'],
      [[4], 'IV'],
      [[9], 'IX'],
      [[58], 'LVIII'],
      [[1994], 'MCMXCIV'],
      [[3999], 'MMMCMXCIX'],
      [[40], 'XL'],
      [[400], 'CD'],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'longestCommonSubstring',
    file: './lcs.js',
    cases: [
      [['abcdef', 'zcdez'], 'cde'],
      [['hello', 'world'], 'l'],
      [['abc', 'def'], ''],
      [['abcabc', 'cabcab'], 'abcab'],
      [['', 'abc'], ''],
      [['xx', 'xxx'], 'xx'],
    ],
    eq: (a, b) => a === b,
  },
  {
    fn: 'isValidEmail',
    file: './email-validate.js',
    cases: [
      [['a@b.co'], true],
      [['user.name+tag@x.io'], true],
      [['a@b'], false],
      [['.a@b.co'], false],
      [['a..b@c.co'], false],
      [['a@-b.co'], false],
      [['a@b.c1'], false],
      [[''], false],
      [['a@b.com'], true],
    ],
    eq: (a, b) => a === b,
  },
];

let totalFailed = 0;
const passedFns = [];
for (const t of tasks) {
  let fnPassed = true;
  let fnRef;
  try {
    fnRef = require(t.file)[t.fn];
    if (typeof fnRef !== 'function') throw new Error('not a function');
  } catch (e) {
    console.error(`${t.fn}: LOAD ERROR ${e.message}`);
    totalFailed++;
    continue;
  }
  for (const [args, want] of t.cases) {
    let got;
    try {
      got = fnRef(...args);
    } catch (e) {
      console.error(`${t.fn} THROW ${JSON.stringify(args)}: ${e.message}`);
      totalFailed++;
      fnPassed = false;
      continue;
    }
    if (!t.eq(got, want)) {
      console.error(
        `${t.fn} FAIL ${JSON.stringify(args)} -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
      );
      totalFailed++;
      fnPassed = false;
    }
  }
  if (fnPassed) passedFns.push(t.fn);
}

console.log(`PASSED_FNS=${passedFns.join(',')}`);
console.log(`PASSED=${passedFns.length}/${tasks.length}`);
if (totalFailed) process.exit(1);
