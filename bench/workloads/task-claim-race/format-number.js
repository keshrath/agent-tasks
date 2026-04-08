// Implement formatNumber(n: number, decimals: number, thousandsSep: string): string
//
// Format a number with a fixed number of decimal places and a thousands
// separator. Rules:
//   - decimals is the number of digits after the decimal point (>= 0).
//     The decimal separator is always '.'.
//   - thousandsSep is inserted between every 3 digits of the integer part,
//     starting from the right.
//   - Negative numbers are prefixed with '-'.
//   - Rounding follows standard "round half away from zero" (i.e. 1.5 -> 2,
//     -1.5 -> -2, 2.5 -> 3).
//   - decimals=0 means NO decimal point at all (not "1.").
//
// Examples:
//   formatNumber(1234567.891, 2, ',')  -> '1,234,567.89'
//   formatNumber(0, 0, ',')            -> '0'
//   formatNumber(-1234.5, 0, '.')      -> '-1.235'  (round half away)
//   formatNumber(0.1 + 0.2, 1, ',')    -> '0.3'
//   formatNumber(999, 2, ',')          -> '999.00'

function formatNumber(n, decimals, thousandsSep) {
  throw new Error('TODO');
}

module.exports = { formatNumber };
