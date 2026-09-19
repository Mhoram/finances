'use strict';

/**
 * Irish CGT Calculation Engine
 *
 * Pure functions — no DB access. All inputs/outputs use plain objects.
 * Monetary values are strings; arithmetic uses Decimal via lib/decimal.js.
 *
 * Matching order per sell, per ISIN:
 *   1. Same-day rule   — buys on the same date (pooled at weighted average cost)
 *   2. 4-week rule     — buys within 28 days AFTER the sell date (earliest first)
 *   3. FIFO            — oldest unconsumed, unreserved buy lots
 *
 * Loss carry-forward:
 *   The caller provides priorLoss (string decimal). The engine computes the
 *   new carry-forward and returns it for chaining into the next year.
 */

const { Decimal, ZERO, toEurStr, toQtyStr } = require('./decimal');

const EXEMPTION = new Decimal('1270');
const CGT_RATE  = new Decimal('0.33');
const DAYS_28   = 28;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function parseDate(str) {
  // Expects YYYY-MM-DD
  return new Date(str + 'T00:00:00Z');
}

function daysBetween(dateA, dateB) {
  // Returns dateB - dateA in whole days
  return Math.round((dateB - dateA) / 86400000);
}

// ---------------------------------------------------------------------------
// Main export: computeYear
// ---------------------------------------------------------------------------

/**
 * Compute CGT for a single tax year.
 *
 * @param {Array}  transactions  All transactions (all years, all ISINs).
 *                               Each: { id, type, date, isin, quantity, price_eur, costs_eur }
 *                               All string decimals; date is YYYY-MM-DD.
 * @param {number} year          Tax year to compute (e.g. 2023).
 * @param {string} priorLoss     Carry-forward loss coming INTO this year (string decimal).
 * @param {string} externalLoss  Additional loss incurred IN this year from outside the system (string decimal).
 *
 * @returns {object} {
 *   disposals:          Array of matched disposal objects,
 *   grossGains:         string,
 *   grossLosses:        string,
 *   priorLossApplied:   string,
 *   netGain:            string,
 *   exemptionApplied:   string,
 *   taxableGain:        string,
 *   taxOwed:            string,
 *   lossCarryForward:   string,   // carry OUT to next year
 *   totalProceeds:      string,
 *   totalCostBasis:     string,
 * }
 */
function computeYear(transactions, year, priorLoss = '0', externalLoss = '0') {
  const prior    = new Decimal(priorLoss    || '0');
  const external = new Decimal(externalLoss || '0');

  // All buys up to and including end of the year (needed for FIFO pool and look-ahead)
  // We need ALL buys across all years for the FIFO pool, but only sells in `year`.
  const allBuys  = transactions.filter(t => t.type === 'buy');
  const yearSells = transactions
    .filter(t => t.type === 'sell' && t.date.startsWith(String(year)))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));

  if (yearSells.length === 0) {
    return emptyResult(prior);
  }

  // Build mutable buy lots (one entry per transaction row)
  // remaining: Decimal quantity still available
  // reserved:  Decimal quantity reserved by a 4-week look-ahead
  const lots = allBuys
    .filter(t => t.date <= String(year) + '-12-31')  // only buys on/before year end
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''))
    .map(t => ({
      id:        t.id,
      isin:      t.isin,
      date:      t.date,
      time:      t.time || '00:00:00',
      quantity:  new Decimal(t.quantity),
      price_eur: new Decimal(t.price_eur),
      costs_eur: new Decimal(t.costs_eur),
      remaining: new Decimal(t.quantity),
      reserved:  ZERO,
    }));

  const disposals = [];

  for (const sell of yearSells) {
    const sellDate = sell.date;
    const sellQty  = new Decimal(sell.quantity);
    const proceeds = new Decimal(sell.price_eur).mul(sellQty).minus(new Decimal(sell.costs_eur));
    let qtyToMatch = sellQty;

    const isinLots = lots.filter(l => l.isin === sell.isin);

    // --- Step 1: Same-day rule ---
    const sameDayLots = isinLots.filter(l => l.date === sellDate && l.remaining.gt(ZERO));
    let sameDayMatched = ZERO;
    let sameDayCost    = ZERO;

    if (sameDayLots.length > 0 && qtyToMatch.gt(ZERO)) {
      // Pool same-day buys at weighted average cost
      const totalSameDayQty  = sameDayLots.reduce((s, l) => s.plus(l.remaining), ZERO);
      const totalSameDayCost = sameDayLots.reduce(
        (s, l) => s.plus(l.remaining.mul(l.price_eur).plus(l.costs_eur)), ZERO
      );
      const avgCost = totalSameDayCost.div(totalSameDayQty); // cost per unit

      const toConsume = Decimal.min(qtyToMatch, totalSameDayQty);
      sameDayMatched = toConsume;
      sameDayCost    = toConsume.mul(avgCost);

      // Consume from same-day lots proportionally
      let remaining = toConsume;
      for (const lot of sameDayLots) {
        if (remaining.lte(ZERO)) break;
        const take = Decimal.min(remaining, lot.remaining);
        lot.remaining = lot.remaining.minus(take);
        remaining = remaining.minus(take);
      }
      qtyToMatch = qtyToMatch.minus(toConsume);
    }

    // --- Step 2: 4-week rule (buy within 28 days AFTER sell date) ---
    const sellDateObj = parseDate(sellDate);
    const fourWeekLots = isinLots
      .filter(l => {
        const d = parseDate(l.date);
        const diff = daysBetween(sellDateObj, d);
        return diff > 0 && diff <= DAYS_28 && l.remaining.plus(l.reserved).gt(ZERO);
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

    let fourWeekMatched = ZERO;
    let fourWeekCost    = ZERO;

    if (fourWeekLots.length > 0 && qtyToMatch.gt(ZERO)) {
      for (const lot of fourWeekLots) {
        if (qtyToMatch.lte(ZERO)) break;
        const available = lot.remaining; // reserved qty is not available for THIS sell (already spoken for by earlier sells)
        if (available.lte(ZERO)) continue;
        const take = Decimal.min(qtyToMatch, available);
        const costPerUnit = lot.price_eur.plus(lot.costs_eur.div(lot.quantity));
        fourWeekMatched = fourWeekMatched.plus(take);
        fourWeekCost    = fourWeekCost.plus(take.mul(costPerUnit));
        lot.remaining   = lot.remaining.minus(take);
        qtyToMatch      = qtyToMatch.minus(take);
      }
    }

    // --- Step 3: FIFO ---
    const fifoLots = isinLots
      .filter(l => l.date <= sellDate && l.remaining.gt(ZERO))
      .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

    let fifoMatched = ZERO;
    let fifoCost    = ZERO;

    if (qtyToMatch.gt(ZERO)) {
      for (const lot of fifoLots) {
        if (qtyToMatch.lte(ZERO)) break;
        const take = Decimal.min(qtyToMatch, lot.remaining);
        const costPerUnit = lot.price_eur.plus(lot.costs_eur.div(lot.quantity));
        fifoMatched = fifoMatched.plus(take);
        fifoCost    = fifoCost.plus(take.mul(costPerUnit));
        lot.remaining = lot.remaining.minus(take);
        qtyToMatch    = qtyToMatch.minus(take);
      }
    }

    const totalMatched = sameDayMatched.plus(fourWeekMatched).plus(fifoMatched);
    const totalCost    = sameDayCost.plus(fourWeekCost).plus(fifoCost);
    const gain         = proceeds.minus(totalCost);

    disposals.push({
      sell_id:         sell.id,
      isin:            sell.isin,
      product_name:    sell.product_name || '',
      date:            sellDate,
      quantity:        toQtyStr(sellQty),
      proceeds:        toEurStr(proceeds),
      cost_basis:      toEurStr(totalCost),
      gain:            toEurStr(gain),
      unmatched_qty:   toQtyStr(qtyToMatch),  // > 0 if not enough buys found (data issue)
      matching_detail: {
        same_day:   { qty: toQtyStr(sameDayMatched),  cost: toEurStr(sameDayCost)  },
        four_week:  { qty: toQtyStr(fourWeekMatched), cost: toEurStr(fourWeekCost) },
        fifo:       { qty: toQtyStr(fifoMatched),     cost: toEurStr(fifoCost)     },
      },
    });
  }

  // --- Tax computation ---
  const grossGains  = disposals.reduce(
    (s, d) => { const g = new Decimal(d.gain); return g.gt(ZERO) ? s.plus(g) : s; }, ZERO
  );
  // grossLosses includes any external loss incurred in this year (e.g. from another broker)
  const grossLosses = disposals.reduce(
    (s, d) => { const g = new Decimal(d.gain); return g.lt(ZERO) ? s.plus(g.abs()) : s; }, ZERO
  ).plus(external);

  const totalProceeds  = disposals.reduce((s, d) => s.plus(new Decimal(d.proceeds)),   ZERO);
  const totalCostBasis = disposals.reduce((s, d) => s.plus(new Decimal(d.cost_basis)), ZERO);

  // Net gain after current-year losses (incl. external) and prior carry-forward
  const netGainBeforeExemption = grossGains.minus(grossLosses).minus(prior);
  const priorLossApplied = prior.gt(ZERO)
    ? Decimal.min(prior, grossGains.minus(grossLosses).gt(ZERO) ? grossGains.minus(grossLosses) : ZERO)
    : ZERO;

  let taxableGain      = ZERO;
  let taxOwed          = ZERO;
  let lossCarryForward = ZERO;
  let exemptionApplied = ZERO;

  if (netGainBeforeExemption.gt(ZERO)) {
    exemptionApplied = Decimal.min(netGainBeforeExemption, EXEMPTION);
    taxableGain      = netGainBeforeExemption.minus(exemptionApplied);
    taxOwed          = taxableGain.mul(CGT_RATE).toDecimalPlaces(2);
    lossCarryForward = ZERO;
  } else {
    // Net loss — carry it forward (exemption NOT applied to avoid inflating the loss)
    lossCarryForward = netGainBeforeExemption.abs();
  }

  return {
    disposals,
    grossGains:        toEurStr(grossGains),
    grossLosses:       toEurStr(grossLosses),   // includes externalLoss
    externalLoss:      toEurStr(external),
    priorLossApplied:  toEurStr(prior),
    netGain:          toEurStr(netGainBeforeExemption),
    exemptionApplied: toEurStr(exemptionApplied),
    taxableGain:      toEurStr(taxableGain),
    taxOwed:          toEurStr(taxOwed),
    lossCarryForward: toEurStr(lossCarryForward),
    totalProceeds:    toEurStr(totalProceeds),
    totalCostBasis:   toEurStr(totalCostBasis),
  };
}

function emptyResult(prior) {
  return {
    disposals:        [],
    grossGains:       '0.00',
    grossLosses:      '0.00',
    priorLossApplied: toEurStr(prior),
    netGain:          toEurStr(ZERO.minus(prior)),
    exemptionApplied: '0.00',
    taxableGain:      '0.00',
    taxOwed:          '0.00',
    lossCarryForward: toEurStr(prior),  // unchanged — rolls forward
    totalProceeds:    '0.00',
    totalCostBasis:   '0.00',
  };
}

/**
 * Compute CGT for all years that have sells, chaining carry-forward losses.
 * Also incorporates manually entered losses from the loss_pool.
 *
 * @param {Array}  transactions  Full transaction list.
 * @param {Array}  lossPool      Array of { tax_year, loss_amount } from DB.
 *                               Each entry is a loss incurred IN that year from outside the system.
 * @returns {Map<number, object>} year → result object
 */
function computeAllYears(transactions, lossPool = []) {
  // manualLosses[year] = additional loss incurred IN that year from outside the system
  const manualLosses = new Map(lossPool.map(r => [r.tax_year, new Decimal(r.loss_amount)]));

  const sellYears = [
    ...new Set(
      transactions
        .filter(t => t.type === 'sell')
        .map(t => parseInt(t.date.slice(0, 4)))
    ),
  ].sort();

  const results = new Map();
  let carryForward = ZERO;

  for (const year of sellYears) {
    const externalThisYear = manualLosses.get(year) || ZERO;
    const result = computeYear(transactions, year, carryForward.toFixed(2), externalThisYear.toFixed(2));
    results.set(year, result);
    carryForward = new Decimal(result.lossCarryForward);
  }

  return results;
}

module.exports = { computeYear, computeAllYears };
