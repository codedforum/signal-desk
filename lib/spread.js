'use strict';
// One real world asset is usually tokenised more than once, by issuers who never
// coordinate on price. The quotes endpoint already returns every one of those
// wrappers, so the dispersion between them is derivable from a response the app
// has in hand. Nothing here calls the API.

// A wrapper only counts as a price if it has one. A zero or a null is an entry
// CoinMarketCap carries without a live quote, and averaging it in would drag the
// whole table toward zero.
const priced = (t) => t && typeof t.price === 'number' && isFinite(t.price) && t.price > 0;

// Volume is the difference between a price you can trade on and a price that is
// merely published. A wrapper with no 24h volume stays in the table, because it
// is part of the picture, but it is never named as the venue to use.
const liquid = (t) => typeof t.volume24h === 'number' && isFinite(t.volume24h) && t.volume24h > 0;

const bps = (price, base) => ((price - base) / base) * 10000;

/**
 * Rank every tokenised version of one asset by price.
 *
 * @param {Array} tokens   rows as /api/rwa/asset returns them
 * @param {number} reference  the asset level price, used as the benchmark the
 *                            wrappers are measured against. Optional.
 * @returns {object|null}  null when no wrapper carries a usable price
 */
function wrapperSpread(tokens, reference) {
  const rows = (Array.isArray(tokens) ? tokens : []).filter(priced)
    .map((t) => ({ ...t }))
    .sort((a, b) => a.price - b.price);
  if (!rows.length) return null;

  const ref = (typeof reference === 'number' && isFinite(reference) && reference > 0)
    ? reference : null;

  const cheapest = rows[0];
  const dearest = rows[rows.length - 1];

  for (const r of rows) {
    r.liquid = liquid(r);
    r.bpsFromCheapest = bps(r.price, cheapest.price);
    r.premiumPct = ref == null ? null : ((r.price - ref) / ref) * 100;
  }

  // The same ranking again over only the wrappers that actually trade, because
  // that is the pair a reader could act on.
  const tradable = rows.filter((r) => r.liquid);

  return {
    count: rows.length,
    unpriced: (Array.isArray(tokens) ? tokens.length : 0) - rows.length,
    reference: ref,
    cheapest,
    dearest,
    spreadBps: bps(dearest.price, cheapest.price),
    tradableCount: tradable.length,
    tradableCheapest: tradable[0] || null,
    tradableDearest: tradable.length > 1 ? tradable[tradable.length - 1] : null,
    tradableSpreadBps: tradable.length > 1
      ? bps(tradable[tradable.length - 1].price, tradable[0].price)
      : null,
    rows,
  };
}

module.exports = { wrapperSpread };
