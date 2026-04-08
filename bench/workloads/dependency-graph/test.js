const path = require('path');

const SPECS = [
  { name: 'a', expected: (v) => v && typeof v === 'object' && v.x === 1 },
  { name: 'b', expected: (v) => v === 3 },
  { name: 'c', expected: (v) => v === 5 },
  { name: 'd', expected: (v) => v === 8 },
  { name: 'e', expected: (v) => v === 'hello' },
  { name: 'f', expected: (v) => v === 42 },
];

const passed = [];
for (const { name, expected } of SPECS) {
  const file = path.join(__dirname, `${name}.js`);
  delete require.cache[require.resolve(file)];
  try {
    const v = require(file);
    if (expected(v)) passed.push(name);
  } catch {
    /* unimplemented or broken */
  }
}

console.log(`PASSED_FNS=${passed.join(',')}`);
process.exit(passed.length === SPECS.length ? 0 : 1);
