'use strict';

const { Decimal, ZERO, toEurStr, toQtyStr } = require('./decimal');

// Current unmatched buy positions grouped by ISIN, with unrealised P&L against
// cached prices. "Unmatched" = total bought - total sold, using simple FIFO.
function computeHoldings(db) {
  const transactions = db.prepare(
    `SELECT * FROM transactions ORDER BY date, time`
  ).all();

  const pool = {}; // isin -> { name, lots: [...] }

  for (const t of transactions) {
    const isin = t.isin;
    if (!pool[isin]) pool[isin] = { name: t.product_name, lots: [] };

    if (t.type === 'buy') {
      pool[isin].lots.push({
        id:        t.id,
        date:      t.date,
        quantity:  new Decimal(t.quantity),
        price_eur: new Decimal(t.price_eur),
        costs_eur: new Decimal(t.costs_eur),
        remaining: new Decimal(t.quantity),
      });
    } else {
      let toConsume = new Decimal(t.quantity);
      for (const lot of pool[isin].lots) {
        if (toConsume.lte(ZERO)) break;
        const take = Decimal.min(toConsume, lot.remaining);
        lot.remaining = lot.remaining.minus(take);
        toConsume = toConsume.minus(take);
      }
    }
  }

  const holdings = [];

  for (const [isin, data] of Object.entries(pool)) {
    const activeLots = data.lots.filter(l => l.remaining.gt(ZERO));
    if (activeLots.length === 0) continue;

    const totalQty  = activeLots.reduce((s, l) => s.plus(l.remaining), ZERO);
    const totalCost = activeLots.reduce((s, l) => {
      const costPerUnit = l.price_eur.plus(l.costs_eur.div(l.quantity));
      return s.plus(l.remaining.mul(costPerUnit));
    }, ZERO);
    const avgCost = totalQty.gt(ZERO) ? totalCost.div(totalQty) : ZERO;

    holdings.push({
      isin,
      product_name:    data.name,
      total_quantity:  toQtyStr(totalQty),
      avg_cost_eur:    toEurStr(avgCost),
      total_cost_eur:  toEurStr(totalCost),
      lots: activeLots.map(l => ({
        id:            l.id,
        date:          l.date,
        quantity_held: toQtyStr(l.remaining),
        price_eur:     toEurStr(l.price_eur),
        cost_basis:    toEurStr(l.remaining.mul(l.price_eur.plus(l.costs_eur.div(l.quantity)))),
      })),
    });
  }

  const priceRows = db.prepare('SELECT isin, price_eur, updated_at FROM prices').all();
  const priceMap  = Object.fromEntries(priceRows.map(r => [r.isin, r]));

  for (const h of holdings) {
    const p = priceMap[h.isin];
    if (p) {
      const qty   = new Decimal(h.total_quantity);
      const cost  = new Decimal(h.total_cost_eur);
      const price = new Decimal(p.price_eur);
      const value = qty.mul(price);
      const gain  = value.minus(cost);
      const pct   = cost.gt(ZERO) ? gain.div(cost).mul(100) : ZERO;
      h.current_price_eur  = toEurStr(price);
      h.current_value_eur  = toEurStr(value);
      h.unrealised_eur     = toEurStr(gain);
      h.unrealised_pct     = pct.toDecimalPlaces(2).toFixed(2);
      h.price_updated_at   = p.updated_at;
    } else {
      h.current_price_eur  = null;
      h.current_value_eur  = null;
      h.unrealised_eur     = null;
      h.unrealised_pct     = null;
      h.price_updated_at   = null;
    }
  }

  holdings.sort((a, b) => a.product_name.localeCompare(b.product_name));
  return holdings;
}

module.exports = { computeHoldings };
