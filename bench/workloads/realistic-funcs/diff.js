// =============================================================================
// diff.js — ONE function to implement.
//
// diffObjects(a, b) — produce a structural diff between two plain JS objects.
//
// Return shape:
//   {
//     added:    { key: newValue, ... }   // keys in b not in a
//     removed:  { key: oldValue, ... }   // keys in a not in b
//     changed:  { key: { from, to }, ... } // keys in both with !== values
//     unchanged: string[]                  // keys in both with === values (sorted)
//   }
//
// Required behavior:
//   - Top-level only (do NOT recurse into nested objects — treat them as
//     opaque values; if a.x === b.x by reference equality it's unchanged,
//     otherwise it's `changed: { from, to }`)
//   - Arrays compared by reference (same as objects)
//   - null and undefined treated as distinct values
//   - NaN compared with Object.is (so NaN === NaN for diff purposes)
//   - Order of keys in returned objects: insertion order based on iteration
//     over `a` first then `b`
//   - `unchanged` is sorted alphabetically
//
// Tests live in test.js. PASSED_FNS=diffObjects on success.

function diffObjects(/* a, b */) {
  // TODO: implement
  throw new Error('not implemented');
}

module.exports = { diffObjects };
