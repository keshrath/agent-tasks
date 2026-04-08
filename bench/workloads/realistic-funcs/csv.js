// =============================================================================
// csv.js — TWO functions to implement.
//
// (1) parseCsv(text, opts?) — parse CSV text into an array of objects.
//     Required behavior:
//       - First non-empty line is the header (unless opts.header is provided)
//       - Quoted fields with embedded commas: `a,"b,c",d` → ['a','b,c','d']
//       - Quoted fields with embedded quotes via doubling: `"he said ""hi"""`
//         → 'he said "hi"'
//       - CRLF and LF both work as line terminators
//       - Trailing newline is tolerated (not a phantom row)
//       - Empty fields are empty string '' (not null/undefined)
//       - opts.header (string[]): override headers and treat all rows as data
//       - opts.skipEmptyLines (boolean, default true)
//     Return: Array of objects keyed by header.
//
// (2) stringifyCsv(rows, opts?) — inverse: serialize array of objects to CSV.
//     Required behavior:
//       - First row is the header (union of keys across all rows, in
//         insertion order from the first row, then any new keys appended)
//       - Quote any field that contains a comma, quote, CR, or LF
//       - Escape embedded quotes by doubling
//       - Use \n as the row terminator (not \r\n)
//       - Missing fields → empty string
//       - opts.headers (string[]): override the header order
//
// Tests live in test.js. PASSED_FNS=parseCsv,stringifyCsv on full success.

function parseCsv(/* text, opts */) {
  // TODO: implement
  throw new Error('not implemented');
}

function stringifyCsv(/* rows, opts */) {
  // TODO: implement
  throw new Error('not implemented');
}

module.exports = { parseCsv, stringifyCsv };
