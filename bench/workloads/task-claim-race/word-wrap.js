// Implement wordWrap(text: string, width: number): string
//
// Wrap a string at the given width without breaking words. Rules:
//   - Words are sequences of non-space characters separated by single spaces.
//   - The output joins lines with '\n'.
//   - No line in the output may exceed `width` characters EXCEPT when a single
//     word is itself longer than `width`, in which case that word goes on its
//     own line (do NOT split the word).
//   - There is no trailing newline.
//   - An empty input returns ''.
//   - Multiple spaces in the input collapse to one (i.e. "a  b" wraps the
//     same as "a b").
//
// Examples:
//   wordWrap('the quick brown fox', 10)
//     -> 'the quick\nbrown fox'
//   wordWrap('hello world', 5)
//     -> 'hello\nworld'
//   wordWrap('supercalifragilistic is long', 5)
//     -> 'supercalifragilistic\nis\nlong'
//   wordWrap('', 10)
//     -> ''

function wordWrap(text, width) {
  throw new Error('TODO');
}

module.exports = { wordWrap };
