'use strict';
// CoinMarketCap client.
//
// Two things here are not decoration.
//
// CAPABILITY. The free tier answers 403 to most of the interesting endpoints, so
// every call records whether it succeeded, was refused by the plan, or failed for
// our own reasons. A panel can then ask "can I be drawn?" instead of throwing.
// The distinction matters: 403 is a plan limit, 405 means we used the wrong HTTP
// method, and 400 means we sent the wrong body. Only the first is the API's fault,
// and conflating them cost real time before this was written.
//
// BUDGET. The free plan is 15,000 credits a month and a poll loop will eat that in
// days. Every response is cached with an explicit TTL, and the credit count the API
// reports back is accumulated so spend is observable rather than a monthly surprise.

const BASE = 'https://pro-api.coinmarketcap.com';

const CACHE_TTL = {
  listings: 5 * 60 * 1000,
  global: 5 * 60 * 1000,
  categories: 60 * 60 * 1000,
  feargreed: 15 * 60 * 1000,
  platforms: 24 * 60 * 60 * 1000,
  trending: 10 * 60 * 1000,
  quotes: 5 * 60 * 1000,
  rwa: 15 * 60 * 1000,
};

const cache = new Map();
const state = {
  creditsUsed: 0,
  calls: 0,
  refused: new Set(),   // endpoints the plan will not serve
  lastError: null,
  startedAt: Date.now(),
};

const key = () => process.env.CMC_API_KEY || '';

function cached(name) {
  const hit = cache.get(name);
  // Keys may be namespaced, for example `categories:5000`, so the TTL is looked
  // up on the prefix before the colon.
  const ttl = CACHE_TTL[name] ?? CACHE_TTL[String(name).split(':')[0]] ?? 5 * 60 * 1000;
  if (hit && Date.now() - hit.at < ttl) return hit;
  return null;
}

/**
 * One call. Never throws: callers get a shaped result and decide what to render.
 * @returns {{ok:boolean, data:any, verdict:'ok'|'plan'|'bad-request'|'wrong-method'|'error', status:number, msg:string}}
 */
async function call(path, { method = 'GET', body = null, name = null } = {}) {
  if (!key()) {
    return { ok: false, data: null, verdict: 'error', status: 0, msg: 'CMC_API_KEY is not set' };
  }
  if (name) {
    const hit = cached(name);
    if (hit) return { ...hit.res, cached: true, age_ms: Date.now() - hit.at };
  }

  const headers = { 'X-CMC_PRO_API_KEY': key(), accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';

  let res;
  try {
    const r = await fetch(BASE + path, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    const msg = j?.status?.error_message || '';
    state.calls += 1;
    if (j?.status?.credit_count) state.creditsUsed += j.status.credit_count;

    const verdict =
      r.status === 200 ? 'ok' :
      r.status === 403 ? 'plan' :
      r.status === 405 ? 'wrong-method' :
      r.status === 400 ? 'bad-request' : 'error';

    if (verdict === 'plan') state.refused.add(path.split('?')[0]);
    if (verdict !== 'ok') state.lastError = { path, status: r.status, msg, at: Date.now() };

    res = { ok: r.status === 200, data: j.data ?? null, verdict, status: r.status, msg };
  } catch (e) {
    state.lastError = { path, status: 0, msg: String(e.message), at: Date.now() };
    res = { ok: false, data: null, verdict: 'error', status: 0, msg: String(e.message) };
  }

  // Cache refusals too. Re-asking a plan-gated endpoint every poll burns nothing
  // in credits but does burn rate limit and latency for an answer that will not
  // change until the subscription does.
  if (name) cache.set(name, { at: Date.now(), res });
  return res;
}

/* ---- the endpoints this product uses, named so the UI can cite them ---- */

const ENDPOINTS = {
  listings:   { path: '/v1/cryptocurrency/listings/latest', method: 'GET',  tier: 'basic' },
  global:     { path: '/v1/global-metrics/quotes/latest',   method: 'GET',  tier: 'basic' },
  categories: { path: '/v1/cryptocurrency/categories',      method: 'GET',  tier: 'basic' },
  feargreed:  { path: '/v3/fear-and-greed/latest',          method: 'GET',  tier: 'basic' },
  platforms:  { path: '/v1/dex/platform/list',              method: 'GET',  tier: 'basic' },
  quotes:     { path: '/v1/cryptocurrency/quotes/latest',   method: 'GET',  tier: 'basic' },
  info:       { path: '/v2/cryptocurrency/info',            method: 'GET',  tier: 'basic' },
  category:   { path: '/v1/cryptocurrency/category',        method: 'GET',  tier: 'basic' },
  trending:   { path: '/v1/cryptocurrency/trending/latest',        method: 'GET', tier: 'paid' },
  movers:     { path: '/v1/cryptocurrency/trending/gainers-losers', method: 'GET', tier: 'paid' },
  fresh:      { path: '/v1/cryptocurrency/listings/new',           method: 'GET', tier: 'paid' },
  dexGainers: { path: '/v1/dex/gainer-loser/list',                 method: 'POST', tier: 'paid' },
  dexNew:     { path: '/v1/dex/new/list',                          method: 'POST', tier: 'paid' },

  // Real world assets. A separate v5 family with its own identifier space: assets
  // carry an rwa_id, not a cryptocurrency id, and issuers are first class objects
  // with no equivalent anywhere else in the API.
  rwaMap:     { path: '/v5/real-world-assets/map',               method: 'GET', tier: 'basic' },
  rwaList:    { path: '/v5/real-world-assets/assets/list',       method: 'GET', tier: 'basic' },
  rwaInfo:    { path: '/v5/real-world-assets/info',              method: 'GET', tier: 'basic' },
  rwaQuotes:  { path: '/v5/real-world-assets/quotes/latest',     method: 'GET', tier: 'basic' },
  rwaIssuers: { path: '/v5/real-world-assets/issuers/list',      method: 'GET', tier: 'basic' },
  rwaIssuer:  { path: '/v5/real-world-assets/issuers',           method: 'GET', tier: 'basic' },
  rwaPairs:   { path: '/v5/real-world-assets/market-pairs/list', method: 'GET', tier: 'paid' },
};

// Asset types the taxonomy defines. Probed live rather than assumed: stock,
// commodity and etf return rows today, the other three answer 200 with an empty
// list, so the UI hides an empty type instead of showing a dead tab.
const RWA_TYPES = ['stock', 'commodity', 'etf', 'currency', 'government_security', 'real_estate'];

const listings = (limit = 200) =>
  call(`${ENDPOINTS.listings.path}?limit=${limit}&convert=USD&sort=market_cap&sort_dir=desc`, { name: 'listings' });

const globalMetrics = () => call(ENDPOINTS.global.path, { name: 'global' });

// The limit is part of the cache key. Without it a 200 row request and a 5000
// row request share an entry, so whichever ran first wins and the larger caller
// silently receives a truncated list. That dropped RWA sectors from nine to six.
const categories = (limit = 100) =>
  call(`${ENDPOINTS.categories.path}?limit=${limit}`, { name: `categories:${limit}` });

const fearGreed = () => call(ENDPOINTS.feargreed.path, { name: 'feargreed' });

const platforms = () => call(`${ENDPOINTS.platforms.path}?limit=500`, { name: 'platforms' });

const trending = (limit = 20) =>
  call(`${ENDPOINTS.trending.path}?limit=${limit}`, { name: 'trending' });

const movers = (limit = 20) =>
  call(`${ENDPOINTS.movers.path}?limit=${limit}`, { name: 'movers' });

// POST with a JSON body. A GET here answers 405, which reads like a broken
// endpoint and is not.
const dexGainers = (opts = {}) =>
  call(ENDPOINTS.dexGainers.path, {
    method: 'POST', name: 'dexGainers',
    body: { type: 'gainer', time_period: '24h', limit: 20, min_liquidity: 25000, ...opts },
  });

const dexNew = (opts = {}) =>
  call(ENDPOINTS.dexNew.path, {
    method: 'POST', name: 'dexNew',
    body: { time_period: '24h', limit: 20, ...opts },
  });

// Quotes for an explicit symbol list. Free tier, one credit per call regardless of
// how many symbols, so batching the watchlist into a single call matters.
const quotes = (symbols = []) => {
  const list = symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean).slice(0, 50);
  if (!list.length) return Promise.resolve({ ok: true, data: {}, verdict: 'ok', status: 200, msg: '' });
  return call(`${ENDPOINTS.quotes.path}?symbol=${encodeURIComponent(list.join(','))}&convert=USD`,
    { name: `quotes:${list.join(',')}` });
};

// Logo and description for the detail drawer.
const info = (symbols = []) => {
  const list = symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean).slice(0, 20);
  if (!list.length) return Promise.resolve({ ok: true, data: {}, verdict: 'ok', status: 200, msg: '' });
  return call(`${ENDPOINTS.info.path}?symbol=${encodeURIComponent(list.join(','))}`, { name: `info:${list.join(',')}` });
};

// One category with its constituent coins. Used for the RWA sector breakdown,
// which complements the v5 asset data: categories aggregates tokenised sectors by
// market cap, which the RWA family does not do.
const category = (id, limit = 100) =>
  call(`${ENDPOINTS.category.path}?id=${encodeURIComponent(id)}&limit=${limit}&convert=USD`, { name: `cat:${id}` });

/* ------------------------- real world assets ------------------------- */

// Every v5 response nests its rows under a named array (`rwa_assets`, `issuers`)
// and sometimes alongside paging fields, so unwrapping is done in one place.
const rwaRows = (data, keyName) => {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data[keyName])) return data[keyName];
  const first = Object.values(data).find(Array.isArray);
  return first || [];
};

const rwaAssets = ({ type = '', limit = 100, sort = 'tokenized_market_cap', dir = 'desc' } = {}) => {
  const q = new URLSearchParams({ limit: String(limit), sort, sort_dir: dir, convert: 'USD' });
  if (type) q.set('asset_type', type);
  return call(`${ENDPOINTS.rwaList.path}?${q}`, { name: `rwa:list:${type}:${limit}:${sort}:${dir}` });
};

const rwaMap = (limit = 250) =>
  call(`${ENDPOINTS.rwaMap.path}?limit=${limit}`, { name: `rwa:map:${limit}` });

const rwaInfo = (ids = []) => {
  const list = ids.map(String).filter(Boolean).slice(0, 20);
  if (!list.length) return Promise.resolve({ ok: true, data: null, verdict: 'ok', status: 200, msg: '' });
  return call(`${ENDPOINTS.rwaInfo.path}?rwa_id=${encodeURIComponent(list.join(','))}`, { name: `rwa:info:${list.join(',')}` });
};

const rwaQuotes = (ids = []) => {
  const list = ids.map(String).filter(Boolean).slice(0, 50);
  if (!list.length) return Promise.resolve({ ok: true, data: null, verdict: 'ok', status: 200, msg: '' });
  return call(`${ENDPOINTS.rwaQuotes.path}?rwa_id=${encodeURIComponent(list.join(','))}&convert=USD`, { name: `rwa:q:${list.join(',')}` });
};

const rwaIssuers = (limit = 100) =>
  call(`${ENDPOINTS.rwaIssuers.path}?limit=${limit}`, { name: `rwa:issuers:${limit}` });

const rwaIssuer = (id, limit = 100) =>
  call(`${ENDPOINTS.rwaIssuer.path}?issuer_id=${encodeURIComponent(id)}&limit=${limit}`, { name: `rwa:issuer:${id}` });

// Paid on the free key. Kept so the capability probe can report it honestly
// rather than the UI pretending the endpoint does not exist.
const rwaPairs = (id, limit = 20) =>
  call(`${ENDPOINTS.rwaPairs.path}?rwa_id=${encodeURIComponent(id)}&limit=${limit}&convert=USD`, { name: `rwa:pairs:${id}` });

const usage = () => ({
  calls: state.calls,
  creditsUsed: state.creditsUsed,
  refused: [...state.refused],
  lastError: state.lastError,
  uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
  hasKey: !!key(),
});

module.exports = {
  ENDPOINTS, RWA_TYPES, call, usage, rwaRows,
  rwaAssets, rwaMap, rwaInfo, rwaQuotes, rwaIssuers, rwaIssuer, rwaPairs,
  listings, globalMetrics, categories, fearGreed, platforms, trending, movers, dexGainers, dexNew,
  quotes, info, category,
};
