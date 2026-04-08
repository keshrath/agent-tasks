// =============================================================================
// template.js — ONE function to implement.
//
// renderTemplate(tpl, vars) — interpolate {{name}} placeholders + filters.
//
// Required behavior:
//   - Replace {{ name }} with String(vars.name). Whitespace inside braces
//     is allowed and ignored: `{{  name  }}` works the same as `{{name}}`.
//   - Missing variable → empty string '' (do NOT throw, do NOT leave the
//     placeholder in the output).
//   - Escape support: `\{{` is a literal `{{` and is NOT interpolated. The
//     leading backslash is consumed.
//   - Filter syntax: `{{ name | upper }}` applies the filter `upper` to the
//     value. Filters can chain: `{{ name | trim | upper }}`. Whitespace
//     around `|` is allowed.
//   - Built-in filters you must implement:
//       upper:  v => String(v).toUpperCase()
//       lower:  v => String(v).toLowerCase()
//       trim:   v => String(v).trim()
//       length: v => String(v == null ? '' : v).length
//       default('x'): if value is null/undefined/'', return 'x'. The
//         argument is single-quoted; the quotes are stripped.
//   - Unknown filter → throw new Error(`unknown filter: <name>`)
//
// Tests live in test.js. PASSED_FNS=renderTemplate on success.

function renderTemplate(/* tpl, vars */) {
  throw new Error('not implemented');
}

module.exports = { renderTemplate };
