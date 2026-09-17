'use strict';
// The dislocation board, shared by the HTTP route, the snapshot recorder and
// the MCP server, so an agent and a browser answer the same question the same
// way. Building it twice is how the two drift apart.

const cmc = require('./cmc');
const { wrapperSpread } = require('./spread');

const num = (v) => (v == null || v === '' ? null : Number(v));

// v5 returns quotes as an ARRAY of per-currency objects keyed by a `symbol`
// field, not as an object keyed by currency the way v1 and v2 do. Reading it
// like a v1 quote yields undefined for every number with no error anywhere.
const usdQuote = (a) => {
  const arr = a && a.quotes;
  if (Array.isArray(arr)) return arr.find((q) => (q.symbol || '').toUpperCase() === 'USD') || arr[0] || {};
  if (arr && typeof arr === 'object') return arr.USD || arr.usd || {};
  return {};
};



// One tokenised asset row, flattened. The v5 quote nests under quotes.USD and
// carries tokenized_market_cap, which is the number that matters here: the value
// actually on chain, not the market cap of the underlying company.
function rwaAssetRow(a) {
  const q = usdQuote(a);
  return {
    id: a.rwa_id ?? a.id,
    symbol: a.symbol || '',
    name: a.name || '',
    slug: a.slug || '',
    type: a.asset_type || '',
    rank: a.rwa_rank ?? null,
    hasTokens: a.has_tokens ?? null,
    price: num(q.average_tokenized_price ?? a.average_tokenized_price),
    tokenizedMarketCap: num(q.tokenized_market_cap ?? a.tokenized_market_cap),
    tokenizedVolume24h: num(q.tokenized_volume_24h ?? a.tokenized_volume_24h),
    lastUpdated: a.last_updated || q.last_updated || null,
  };
}

async function spreadBoard(limit = 50) {
  const list = await cmc.rwaAssets({ limit });
  if (!list.ok) return { ok: false, verdict: list.verdict, msg: list.msg, data: [] };

  const ids = cmc.rwaRows(list.data, 'rwa_assets').map((r) => r.rwa_id ?? r.id).filter(Boolean);
  if (!ids.length) return { ok: true, scanned: 0, ranked: 0, offScaleTotal: 0, data: [] };

  const q = await cmc.rwaQuotes(ids);
  if (!q.ok) return { ok: false, verdict: q.verdict, msg: q.msg, data: [] };

  const rows = [];
  let offScaleTotal = 0;
  for (const raw of cmc.rwaRows(q.data, 'rwa_assets')) {
    const asset = rwaAssetRow(raw);
    const tokens = (Array.isArray(raw.tokens) ? raw.tokens : []).map((t) => ({
      symbol: t.symbol || '', name: t.name || '',
      price: num(t.price), marketCap: num(t.market_cap), volume24h: num(t.volume_24h),
      issuer: t.issuer_name || '', issuerId: t.issuer_id || '',
    }));
    const s = wrapperSpread(tokens, asset.price);
    if (!s) continue;
    offScaleTotal += s.offScale.length;
    // One venue cannot disagree with itself, so an asset with a single tradable
    // wrapper has no spread to report and is left out rather than shown as zero.
    if (s.tradableSpreadBps == null) continue;
    rows.push({
      id: asset.id, symbol: asset.symbol, name: asset.name, type: asset.type,
      reference: asset.price,
      tokenizedVolume24h: asset.tokenizedVolume24h,
      wrappers: s.count,
      tradable: s.tradableCount,
      offScale: s.offScale.length,
      spreadBps: s.spreadBps,
      tradableSpreadBps: s.tradableSpreadBps,
      // The figure the board is ordered by. A wide gap between two venues that
      // between them hold a rounding error of the volume is a small fact, and
      // this is what says so.
      weightedSpreadBps: s.weightedSpreadBps,
      vwap: s.vwap,
      liquidVolume: s.liquidVolume,
      concentration: s.concentration,
      cheapest: { symbol: s.tradableCheapest.symbol, issuer: s.tradableCheapest.issuer, price: s.tradableCheapest.price, volumeShare: s.tradableCheapest.volumeShare },
      dearest: { symbol: s.tradableDearest.symbol, issuer: s.tradableDearest.issuer, price: s.tradableDearest.price, volumeShare: s.tradableDearest.volumeShare },
    });
  }
  rows.sort((a, b) => b.weightedSpreadBps - a.weightedSpreadBps);
  return { ok: true, scanned: ids.length, ranked: rows.length, offScaleTotal, data: rows };
}

module.exports = { num, usdQuote, rwaAssetRow, spreadBoard };
