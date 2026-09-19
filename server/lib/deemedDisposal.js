'use strict';

/**
 * Irish Offshore Funds / ETF Exit Tax Engine (TCA 1997 s.747E)
 *
 * Pure functions — no DB access. All inputs/outputs use plain objects.
 * Monetary values are strings; arithmetic uses Decimal via lib/decimal.js.
 *
 * Applies to ISINs classified as "equivalent" offshore funds (UCITS ETFs etc.),
 * NOT ordinary shares handled by lib/cgt.js. Those are mutually exclusive regimes —
 * an ISIN's transactions should only ever flow through one of the two engines.
 *
 * Key rules (Revenue TDM Part 27-04-01, reviewed Jan 2026):
 *   - Deemed disposal every 8 years from acquisition, per lot.
 *   - Rate: 41% (2014-2025), 38% (2026 onward, Finance Act 2025).
 *   - 2nd+ deemed disposal on a lot is taxed on growth SINCE THE LAST deemed
 *     disposal (not since original acquisition) — avoids double-taxing the same
 *     growth. (TDM wording is ambiguous here; this is the confirmed interpretation.)
 *   - Actual disposal: gain = proceeds - ORIGINAL cost of acquisition. Tax already
 *     paid on prior deemed disposals is a non-refundable credit against tax due.
 *   - No loss relief on ETF disposals (s.747E(3)/(4)) - losses cannot offset CGT
 *     gains or other losses, and are not carried forward.
 *   - Pay & file deadline: 31 October of the year following the chargeable event
 *     (statutory baseline; ROS online filers typically get a short extension
 *     announced annually — not modelled here).
 */

const { Decimal, ZERO, toEurStr, toQtyStr } = require('./decimal');

const YEARS_PER_CYCLE = 8;

// Rate applicable to offshore-fund disposals/deemed disposals (non-regular payment
// including disposal, non-PPIU column of TDM Part 27-04-01 Table 1).
const RATE_SCHEDULE = [
  { from: '2014-01-01', to: '2025-12-31', rate: '0.41' },
  { from: '2026-01-01', to: null,         rate: '0.38' },
];

function rateForDate(dateStr) {
  const band = RATE_SCHEDULE.find(b => dateStr >= b.from && (b.to === null || dateStr <= b.to));
  if (band) return new Decimal(band.rate);
  // Before the schedule starts or otherwise unmatched — fall back to the earliest known rate.
  return new Decimal(RATE_SCHEDULE[0].rate);
}

function payFileDeadline(disposalDate) {
  const year = parseInt(disposalDate.slice(0, 4), 10);
  return `${year + 1}-10-31`;
}

function addYears(dateStr, years) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y + years, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// ETF classification
// ---------------------------------------------------------------------------

const ETF_KEYWORD_RE = /etf/i;

/**
 * @param {string} isin
 * @param {string} productName
 * @param {object} overrides  isin -> boolean, from etf_flags table
 * @returns {boolean}
 */
function isEtf(isin, productName, overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, isin)) return !!overrides[isin];
  return ETF_KEYWORD_RE.test(productName || '');
}

// ---------------------------------------------------------------------------
// Lot pool (FIFO), matches the pooling logic in routes/holdings.js
// ---------------------------------------------------------------------------

/**
 * @param {Array} transactions  All transactions for a single ISIN, any order.
 * @returns {Array} lots — one per buy, with `remaining` (Decimal) after FIFO sell consumption.
 */
function buildLotPool(transactions) {
  const sorted = [...transactions].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '')
  );

  const lots = [];
  for (const t of sorted) {
    if (t.type === 'buy') {
      const qty       = new Decimal(t.quantity);
      const price     = new Decimal(t.price_eur);
      const costs     = new Decimal(t.costs_eur);
      const costBasis = qty.mul(price).plus(costs);
      lots.push({
        lot_id:            t.id,
        isin:              t.isin,
        product_name:      t.product_name || '',
        date:              t.date,
        quantity:          qty,
        cost_basis_total:  costBasis,               // original total cost for the full lot
        cost_basis_per_unit: costBasis.div(qty),
        remaining:         qty,
      });
    } else {
      let toConsume = new Decimal(t.quantity);
      for (const lot of lots) {
        if (toConsume.lte(ZERO)) break;
        const take = Decimal.min(toConsume, lot.remaining);
        lot.remaining = lot.remaining.minus(take);
        toConsume     = toConsume.minus(take);
      }
    }
  }

  return lots;
}

// ---------------------------------------------------------------------------
// Deemed disposal schedule
// ---------------------------------------------------------------------------

/**
 * Compute the deemed-disposal schedule for every open lot of one ISIN.
 *
 * @param {Array}  lots                From buildLotPool(), only lots with remaining > 0 matter.
 * @param {string} currentPriceEur     Latest known market price per unit (string decimal), or null.
 * @param {Array}  confirmedDisposals  Rows from deemed_disposals for this ISIN (any lot/cycle).
 * @param {string} today               YYYY-MM-DD, defaults to real today.
 * @returns {Array} one entry per open lot: { lot_id, isin, product_name, date, quantity,
 *   cycle, opening_value, anniversary, status: 'due'|'upcoming'|'no_price',
 *   projected_gain, projected_tax, tax_rate, pay_by, confirmed_history }
 */
function computeSchedule(lots, currentPriceEur, confirmedDisposals = [], today = new Date().toISOString().slice(0, 10)) {
  const byLotCycle = new Map(confirmedDisposals.map(d => [`${d.lot_id}:${d.cycle}`, d]));
  const price = currentPriceEur !== null && currentPriceEur !== undefined ? new Decimal(currentPriceEur) : null;

  const results = [];

  for (const lot of lots.filter(l => l.remaining.gt(ZERO))) {
    let cycle       = 1;
    let opening     = lot.cost_basis_per_unit.mul(lot.remaining); // basis for the units still held
    let basisDate   = lot.date;
    const history   = [];

    // Walk forward through any already-confirmed cycles to find where we currently stand.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const confirmed = byLotCycle.get(`${lot.lot_id}:${cycle}`);
      if (!confirmed) break;
      history.push(confirmed);
      opening   = new Decimal(confirmed.closing_value);
      basisDate = confirmed.disposal_date;
      cycle    += 1;
    }

    const anniversary = addYears(basisDate, YEARS_PER_CYCLE);
    const isDue        = anniversary <= today;

    let projectedGain = null, projectedTax = null, status;
    if (price === null) {
      status = 'no_price';
    } else {
      const value   = lot.remaining.mul(price);
      const gain    = value.minus(opening);
      const rate    = rateForDate(anniversary);
      projectedGain = toEurStr(gain);
      projectedTax  = toEurStr(Decimal.max(ZERO, gain).mul(rate));
      status        = isDue ? 'due' : 'upcoming';
    }

    results.push({
      lot_id:            lot.lot_id,
      isin:              lot.isin,
      product_name:      lot.product_name,
      acquisition_date:  lot.date,
      quantity_held:     toQtyStr(lot.remaining),
      cycle,
      opening_value:     toEurStr(opening),
      anniversary,
      status,
      projected_gain:    projectedGain,
      projected_tax:     projectedTax,
      tax_rate:          rateForDate(anniversary).toFixed(2),
      pay_by:            payFileDeadline(anniversary),
      confirmed_history: history,
    });
  }

  return results;
}

/**
 * Build a confirmed deemed_disposals row from a user-entered price at a given cycle.
 * Does not touch the DB — caller inserts the returned row.
 *
 * @param {object} lot              One lot from buildLotPool() (or equivalent shape).
 * @param {number} cycle            Which 8-year cycle this confirms.
 * @param {string} disposalDate     YYYY-MM-DD anniversary date.
 * @param {string} openingValue     Basis carried in (string decimal).
 * @param {string} priceEur         Market price per unit at disposalDate.
 */
function buildConfirmedDisposal(lot, cycle, disposalDate, openingValue, priceEur) {
  const qty      = lot.remaining;
  const opening  = new Decimal(openingValue);
  const closing  = qty.mul(new Decimal(priceEur));
  const gain     = closing.minus(opening);
  const rate     = rateForDate(disposalDate);
  const taxPaid  = Decimal.max(ZERO, gain).mul(rate);

  return {
    lot_id:         lot.lot_id,
    isin:           lot.isin,
    cycle,
    disposal_date:  disposalDate,
    quantity:       toQtyStr(qty),
    opening_value:  toEurStr(opening),
    closing_value:  toEurStr(closing),
    gain_eur:       toEurStr(gain),
    tax_rate:       rate.toFixed(2),
    tax_paid_eur:   toEurStr(taxPaid),
  };
}

// ---------------------------------------------------------------------------
// Actual disposals (real sells) of ETF-classified ISINs
// ---------------------------------------------------------------------------

/**
 * Compute realised ETF disposals for one tax year, applying the deemed-disposal
 * credit. Matching is straight FIFO (no same-day/4-week CGT anti-avoidance rules —
 * those don't apply to the offshore funds regime). Sells on the same date are
 * combined into a single disposal event before computing gain/loss — a broker
 * order filled across several executions at different prices (same date, same
 * order) is one economic disposal, not several; treating each fill separately
 * would tax a same-day gain fill while discarding same-day loss fills under the
 * no-loss-relief rule, materially overstating tax owed.
 *
 * @param {Array}  transactions        All transactions for a single ISIN.
 * @param {number} year
 * @param {Array}  confirmedDisposals  Rows from deemed_disposals for this ISIN.
 * @returns {Array} disposal entries: { date, quantity, proceeds, cost_basis,
 *   gain, tax_rate, tax_before_credit, credit_applied, tax_due }
 */
function computeActualDisposals(transactions, year, confirmedDisposals = []) {
  const sorted = [...transactions].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '')
  );

  const isin        = sorted[0]?.isin;
  const productName = sorted.find(t => t.product_name)?.product_name || '';

  // Build the full buy-lot pool up front, in date order (mirrors lib/cgt.js's FIFO step).
  const lots = sorted
    .filter(t => t.type === 'buy')
    .map(t => {
      const qty   = new Decimal(t.quantity);
      const price = new Decimal(t.price_eur);
      const costs = new Decimal(t.costs_eur);
      return {
        lot_id:              t.id,
        date:                t.date,
        remaining:           qty,
        cost_basis_per_unit: qty.mul(price).plus(costs).div(qty),
      };
    });

  // Track remaining deemed-disposal credit per lot.
  const creditByLot = new Map();
  for (const d of confirmedDisposals) {
    const prev = creditByLot.get(d.lot_id) || ZERO;
    creditByLot.set(d.lot_id, prev.plus(new Decimal(d.tax_paid_eur)));
  }

  // Group same-date sells into one disposal event.
  const sellsByDate = new Map();
  for (const t of sorted) {
    if (t.type !== 'sell') continue;
    const proceeds = new Decimal(t.price_eur).mul(new Decimal(t.quantity)).minus(new Decimal(t.costs_eur));
    const existing = sellsByDate.get(t.date);
    if (existing) {
      existing.quantity  = existing.quantity.plus(new Decimal(t.quantity));
      existing.proceeds  = existing.proceeds.plus(proceeds);
      existing.sell_ids.push(t.id);
    } else {
      sellsByDate.set(t.date, { date: t.date, quantity: new Decimal(t.quantity), proceeds, sell_ids: [t.id] });
    }
  }

  const disposals = [];

  for (const sellEvent of [...sellsByDate.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    let toMatch    = sellEvent.quantity;
    let costBasis  = ZERO;
    let creditPool = ZERO;

    for (const lot of lots) {
      if (toMatch.lte(ZERO)) break;
      if (lot.date > sellEvent.date || lot.remaining.lte(ZERO)) continue;
      const take = Decimal.min(toMatch, lot.remaining);
      costBasis  = costBasis.plus(take.mul(lot.cost_basis_per_unit));

      const lotCredit = creditByLot.get(lot.lot_id);
      if (lotCredit && lotCredit.gt(ZERO)) {
        // Apportion the lot's remaining credit by the fraction of its outstanding quantity consumed here.
        const before     = lot.remaining;
        const portion    = before.gt(ZERO) ? take.div(before) : ZERO;
        const usedCredit = lotCredit.mul(portion);
        creditPool = creditPool.plus(usedCredit);
        creditByLot.set(lot.lot_id, lotCredit.minus(usedCredit));
      }
      lot.remaining = lot.remaining.minus(take);
      toMatch        = toMatch.minus(take);
    }

    if (!sellEvent.date.startsWith(String(year))) continue;

    const gain      = sellEvent.proceeds.minus(costBasis);
    const rate      = rateForDate(sellEvent.date);
    const taxBefore = Decimal.max(ZERO, gain).mul(rate);
    const taxDue    = Decimal.max(ZERO, taxBefore.minus(creditPool));

    disposals.push({
      sell_ids:           sellEvent.sell_ids,
      isin,
      product_name:       productName,
      date:               sellEvent.date,
      quantity:           toQtyStr(sellEvent.quantity),
      proceeds:           toEurStr(sellEvent.proceeds),
      cost_basis:         toEurStr(costBasis),
      gain:               toEurStr(gain),
      tax_rate:           rate.toFixed(2),
      tax_before_credit:  toEurStr(taxBefore),
      credit_applied:     toEurStr(creditPool),
      tax_due:            toEurStr(taxDue),
      loss_relief:        gain.lt(ZERO) ? 'none (s.747E(3) — ETF losses cannot offset CGT or other losses)' : null,
    });
  }

  return disposals;
}

module.exports = {
  isEtf,
  rateForDate,
  payFileDeadline,
  buildLotPool,
  computeSchedule,
  buildConfirmedDisposal,
  computeActualDisposals,
  YEARS_PER_CYCLE,
};
