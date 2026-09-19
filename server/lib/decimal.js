const Decimal = require('decimal.js');

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

const ZERO = new Decimal('0');

/**
 * Round to 2 decimal places (EUR amounts for display/storage).
 */
function toEur(d) {
  return new Decimal(d).toDecimalPlaces(2);
}

/**
 * Round to 8 decimal places (quantities — DeGiro supports fractional shares).
 */
function toQty(d) {
  return new Decimal(d).toDecimalPlaces(8);
}

/**
 * Convert a Decimal (or string/number) to a string safe for DB storage.
 * Uses toFixed() to prevent scientific notation.
 */
function toStr(d, dp = 10) {
  return new Decimal(d).toFixed(dp).replace(/\.?0+$/, '') || '0';
}

/**
 * Convert a Decimal to a fixed-2dp EUR string for storage.
 */
function toEurStr(d) {
  return new Decimal(d).toFixed(2);
}

/**
 * Convert a Decimal to a fixed-8dp quantity string for storage.
 */
function toQtyStr(d) {
  return new Decimal(d).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

module.exports = { Decimal, ZERO, toEur, toQty, toStr, toEurStr, toQtyStr };
