// Implement toRoman(n: number): string
//
// Convert an integer in [1, 3999] to its Roman numeral representation.
// Rules:
//   - Use standard subtractive notation: IV (4), IX (9), XL (40), XC (90),
//     CD (400), CM (900).
//   - Letters: I=1, V=5, X=10, L=50, C=100, D=500, M=1000.
//   - Inputs outside [1, 3999] should throw new Error('out of range').
//   - Non-integers should throw new Error('out of range').
//
// Examples:
//   toRoman(1)    -> 'I'
//   toRoman(4)    -> 'IV'
//   toRoman(9)    -> 'IX'
//   toRoman(58)   -> 'LVIII'      (50 + 5 + 3)
//   toRoman(1994) -> 'MCMXCIV'    (1000 + 900 + 90 + 4)
//   toRoman(3999) -> 'MMMCMXCIX'

function toRoman(n) {
  throw new Error('TODO');
}

module.exports = { toRoman };
