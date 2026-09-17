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
// merely published, and the line is not at zero. Venues carrying nine dollars
// of daily volume quote prices hundreds of basis points from everyone else and
// hold them there, so treating any volume at all as tradable puts a dead quote
// at the top of a dislocation ranking and calls it a finding.
//
// The floor is deliberately low. It is not a claim about how much size a venue
// can absorb, only about whether a price is being tested by anyone at all.
const LIQUID_MIN = 10000;

const vol = (t) => (typeof t.volume24h === 'number' && isFinite(t.volume24h)) ? t.volume24h : 0;
const liquid = (t) => vol(t) >= LIQUID_MIN;
// Traded, but too little to be evidence of anything. Named separately from
// dead, because "nobody is trading this" and "nothing trades here" differ.
const thin = (t) => vol(t) > 0 && vol(t) < LIQUID_MIN;

const bps = (price, base) => ((price - base) / base) * 10000;

// Wrappers of one asset do not always quote the same unit. Gold is the clear
// case: some tokens are one troy ounce and some are one gram, a factor of
// 31.1, so ranking them against each other produces a spread in the hundreds
// of thousands of basis points that means nothing. A real dislocation between
// two wrappers of the same unit is a fraction of a percent, so anything this
// far from the anchor is a different denomination or a broken quote, and
// either way it cannot be ranked.
const SCALE_BAND = 0.25;

// Where the volume actually trades. A plain average treats a venue doing eleven
// thousand dollars as equal to one doing three hundred million, which is how a
// rounding error ends up setting an asset's fair price.
const vwapOf = (rows) => {
  const v = rows.reduce((s, r) => s + r.volume24h, 0);
  return v > 0 ? rows.reduce((s, r) => s + r.price * r.volume24h, 0) / v : null;
};

// The price at a given share of cumulative volume, over rows already sorted by
// price. Used for both ends of the weighted spread, so a venue holding one
// percent of the volume cannot define where the range starts or stops.
const volumeQuantile = (sorted, total, target) => {
  let cum = 0;
  for (const r of sorted) {
    cum += r.volume24h / total;
    if (cum >= target) return r.price;
  }
  return sorted[sorted.length - 1].price;
};

// The middle of the traded volume. Ten percent at each end is enough to ignore
// a single dust venue without discarding a genuine two sided disagreement.
const TAIL = 0.10;

const median = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Rank every tokenised version of one asset by price.
 *
 * @param {Array} tokens   rows as /api/rwa/asset returns them
 * @param {number} reference  the asset level price, used as the benchmark the
 *                            wrappers are measured against. Optional.
 * @returns {object|null}  null when no wrapper carries a usable price
 */
function wrapperSpread(tokens, reference) {
  const all = (Array.isArray(tokens) ? tokens : []).filter(priced)
    .map((t) => ({ ...t }))
    .sort((a, b) => a.price - b.price);
  if (!all.length) return null;

  const ref = (typeof reference === 'number' && isFinite(reference) && reference > 0)
    ? reference : null;

  // The asset level price is CoinMarketCap's own aggregate, so it is the best
  // statement of which unit the asset is quoted in. Without it the median of
  // the wrappers is the next most robust anchor, because it follows whichever
  // denomination most of them use rather than whichever is largest.
  const anchor = ref != null ? ref : median(all.map((t) => t.price));
  const onScale = (t) => t.price >= anchor * (1 - SCALE_BAND)
                      && t.price <= anchor * (1 + SCALE_BAND);

  const rows = all.filter(onScale);
  const offScale = all.filter((t) => !onScale(t));
  // Every wrapper disagreeing with the anchor means the anchor is the odd one
  // out, so there is nothing trustworthy to rank and saying so beats guessing.
  if (!rows.length) return null;

  const cheapest = rows[0];
  const dearest = rows[rows.length - 1];

  for (const r of rows) { r.liquid = liquid(r); r.thin = thin(r); }

  // The same ranking again over only the wrappers that actually trade, because
  // that is the pair a reader could act on.
  const tradable = rows.filter((r) => r.liquid);

  // Everything is measured against the cheapest wrapper that actually trades,
  // not the cheapest quote. A venue with no volume can sit far below the rest
  // and stay there, and measuring from it would report that stale number as
  // every other wrapper's premium. A wrapper quoted under the baseline gets a
  // negative figure, which together with its volume says plainly that the
  // price is published rather than available.
  const baseline = tradable[0] || cheapest;

  // Everything below is weighted by where trading actually happens, so a wide
  // gap between two venues nobody uses reads as the small fact it is.
  const liquidVolume = tradable.reduce((s, r) => s + r.volume24h, 0);
  const vwap = vwapOf(tradable);
  const weightedSpreadBps = (tradable.length > 1 && liquidVolume > 0)
    ? bps(volumeQuantile(tradable, liquidVolume, 1 - TAIL),
          volumeQuantile(tradable, liquidVolume, TAIL))
    : null;

  for (const r of rows) {
    r.bpsFromBaseline = bps(r.price, baseline.price);
    r.isBaseline = r === baseline;
    r.premiumPct = ref == null ? null : ((r.price - ref) / ref) * 100;
    r.volumeShare = (r.liquid && liquidVolume > 0) ? r.volume24h / liquidVolume : 0;
    r.bpsFromVwap = vwap == null ? null : bps(r.price, vwap);
  }

  return {
    count: rows.length,
    unpriced: (Array.isArray(tokens) ? tokens.length : 0) - all.length,
    // Shown, never ranked. A gram denominated gold token is a real wrapper and
    // worth naming, it just cannot be compared to an ounce denominated one.
    offScale: offScale.map((t) => ({ ...t, ratioToAnchor: t.price / anchor })),
    anchor,
    reference: ref,
    cheapest,
    dearest,
    baseline,
    spreadBps: bps(dearest.price, cheapest.price),
    tradableCount: tradable.length,
    tradableCheapest: tradable[0] || null,
    tradableDearest: tradable.length > 1 ? tradable[tradable.length - 1] : null,
    tradableSpreadBps: tradable.length > 1
      ? bps(tradable[tradable.length - 1].price, tradable[0].price)
      : null,
    // The volume weighted price, and the range the middle of that volume sits
    // in. The raw spread says two venues disagree; this says whether enough
    // money is on either side of the disagreement for it to matter.
    vwap,
    liquidVolume,
    weightedSpreadBps,
    // The share held by the single deepest venue. At ninety percent the asset
    // has one real market and a set of quotes, which is worth saying outright.
    concentration: liquidVolume > 0
      ? Math.max(...tradable.map((r) => r.volume24h)) / liquidVolume
      : null,
    rows,
  };
}

module.exports = { wrapperSpread, LIQUID_MIN, SCALE_BAND, TAIL };
