// Implement parseRow(line: string): string[]
//
// Parse a single CSV row into an array of fields. Rules:
//   - Fields are separated by commas.
//   - A field may be quoted with double quotes; quoted fields can contain
//     commas without splitting.
//   - Inside a quoted field, two consecutive double quotes ("") represent a
//     single literal double quote.
//   - Leading/trailing whitespace OUTSIDE quotes is preserved as-is.
//   - Empty fields are valid (e.g. "a,,b" -> ["a", "", "b"]).
//   - An empty input string returns [""].
//
// Examples:
//   parseRow('a,b,c')              -> ['a', 'b', 'c']
//   parseRow('"a,b",c')            -> ['a,b', 'c']
//   parseRow('"he said ""hi"""')   -> ['he said "hi"']
//   parseRow('a,,b')               -> ['a', '', 'b']
//   parseRow('')                   -> ['']

function parseRow(line) {
  throw new Error('TODO');
}

module.exports = { parseRow };
