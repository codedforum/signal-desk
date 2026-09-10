'use strict';
// The analysis layer. CMC returns rows; this turns them into the three answers
// the dashboard exists to give.
//
// Everything here works on the FREE tier. The paid endpoints add breadth, not
// substance, which is deliberate: a product that only works after someone pays
// is a product nobody can evaluate.

const cmc = require('./cmc');

/* ------------------------------------------------------------------ regime */
// One question: is this a market where risk is being taken, or reduced?
// Answered from three free signals rather than a single index, because any one
// of them alone is noise.
function regimeFrom(globalData, fgData) {
  const q = globalData?.quote?.USD || {};
  const btcDom = Number(globalData?.btc_dominance ?? 0);
  const mcapChange = Number(q.total_market_cap_yesterday_percentage_change ?? 0);
  const fgValue = Number(fgData?.value ?? (Array.isArray(fgData) ? fgData[0]?.value : 0) ?? 0);

  // Rising dominance with a falling tape means money is hiding in BTC. Falling
  // dominance with a rising tape is the classic risk-on rotation into alts.
  let stance, why;
  if (mcapChange >= 1 && btcDom < 55) {
    stance = 'risk on';
    why = 'total cap rising while BTC dominance sits below 55%, which is money moving out along the curve';
  } else if (mcapChange <= -1 && btcDom >= 55) {
    stance = 'risk off';
    why = 'total cap falling while dominance holds above 55%, the shape of a flight back into BTC';
  } else if (mcapChange <= -1) {
    stance = 'broad decline';
    why = 'total cap falling without a dominance bid, so weakness is not rotational';
  } else if (mcapChange >= 1) {
    stance = 'bid, led by BTC';
    why = 'total cap rising with dominance elevated, so strength is concentrated rather than broad';
  } else {
    stance = 'range';
    why = 'total cap inside one percent, no directional commitment';
  }

  return {
    stance, why,
    totalMarketCap: q.total_market_cap ?? null,
    volume24h: q.total_volume_24h ?? null,
    mcapChange24h: mcapChange,
    btcDominance: btcDom,
    ethDominance: Number(globalData?.eth_dominance ?? 0),
    fearGreed: fgValue || null,
    fearGreedLabel: fgData?.value_classification || (Array.isArray(fgData) ? fgData[0]?.value_classification : null) || null,
    activeCryptos: globalData?.active_cryptocurrencies ?? null,
  };
}

/* ----------------------------------------------------------------- breadth */
// Percentage of the top N that is green. A tape can rise on five names while
// most things bleed, and the headline number will not tell you.
function breadthFrom(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const pct = (r) => Number(r?.quote?.USD?.percent_change_24h ?? 0);
  const up = rows.filter((r) => pct(r) > 0).length;
  const strong = rows.filter((r) => pct(r) >= 5).length;
  const weak = rows.filter((r) => pct(r) <= -5).length;
  const median = [...rows].map(pct).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  return {
    sampled: rows.length,
    advancing: up,
    declining: rows.length - up,
    advancePct: +((up / rows.length) * 100).toFixed(1),
    strongGainers: strong,
    strongLosers: weak,
    median24h: +median.toFixed(2),
  };
}

/* ---------------------------------------------------------------- rotation */
// Where money went, by sector. CMC's category rows already carry an average
// change and a market cap, which is enough to rank rotation without paying for
// the trending endpoints.
function rotationFrom(cats, limit = 12) {
  if (!Array.isArray(cats) || !cats.length) return [];
  return cats
    .filter((c) => Number(c.market_cap) > 0 && Number(c.num_tokens) >= 5)
    .map((c) => ({
      id: c.id,
      name: c.name,
      tokens: c.num_tokens,
      marketCap: Number(c.market_cap),
      change24h: +Number(c.market_cap_change ?? c.avg_price_change ?? 0).toFixed(2),
      volume24h: Number(c.volume ?? 0),
    }))
    .sort((a, b) => b.change24h - a.change24h)
    .slice(0, limit);
}

/* -------------------------------------------------------------- leaderboard */
// Movers computed from the free listings call, so this panel works without the
// paid gainers/losers endpoint. Same answer, one call, no plan gate.
function moversFrom(rows, limit = 10) {
  if (!Array.isArray(rows) || !rows.length) return { gainers: [], losers: [] };
  const shape = (r) => ({
    id: r.id,
    symbol: r.symbol,
    name: r.name,
    price: r.quote?.USD?.price ?? null,
    change24h: +Number(r.quote?.USD?.percent_change_24h ?? 0).toFixed(2),
    change7d: +Number(r.quote?.USD?.percent_change_7d ?? 0).toFixed(2),
    volume24h: r.quote?.USD?.volume_24h ?? null,
    marketCap: r.quote?.USD?.market_cap ?? null,
    rank: r.cmc_rank ?? null,
  });
  const sorted = [...rows].sort(
    (a, b) => Number(b.quote?.USD?.percent_change_24h ?? 0) - Number(a.quote?.USD?.percent_change_24h ?? 0)
  );
  return {
    gainers: sorted.slice(0, limit).map(shape),
    losers: sorted.slice(-limit).reverse().map(shape),
  };
}

/* ------------------------------------------------------------------ chains */
// The DEX platform list is free, and it is the one place CMC's reach is visibly
// wider than the usual vendors: the long tail chains are all in here.
function chainsFrom(rows, highlight = []) {
  if (!Array.isArray(rows)) return { total: 0, highlighted: [] };
  const wanted = highlight.map((h) => h.toLowerCase());
  const found = [];
  for (const want of wanted) {
    const hit = rows.find((r) => JSON.stringify(r).toLowerCase().includes(want));
    if (hit) found.push({ query: want, id: hit.id, name: hit.n || hit.dn || want });
  }
  return { total: rows.length, highlighted: found };
}

async function build({ highlightChains = [] } = {}) {
  const [g, fg, list, cats, plats] = await Promise.all([
    cmc.globalMetrics(), cmc.fearGreed(), cmc.listings(200), cmc.categories(200), cmc.platforms(),
  ]);

  const listRows = Array.isArray(list.data) ? list.data : [];
  const fgData = Array.isArray(fg.data) ? fg.data[0] : fg.data;

  return {
    at: new Date().toISOString(),
    regime: g.ok ? regimeFrom(g.data, fgData) : null,
    breadth: breadthFrom(listRows),
    rotation: rotationFrom(cats.data),
    movers: moversFrom(listRows),
    chains: chainsFrom(plats.data, highlightChains),
    sources: {
      global: g.verdict, feargreed: fg.verdict, listings: list.verdict,
      categories: cats.verdict, platforms: plats.verdict,
    },
  };
}

module.exports = { build, regimeFrom, breadthFrom, rotationFrom, moversFrom, chainsFrom };
