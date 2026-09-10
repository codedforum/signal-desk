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
  if (hit && Date.now() - hit.at < (CACHE_TTL[name] ?? 5 * 60 * 1000)) return hit;
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
};

const listings = (limit = 200) =>
  call(`${ENDPOINTS.listings.path}?limit=${limit}&convert=USD&sort=market_cap&sort_dir=desc`, { name: 'listings' });

const globalMetrics = () => call(ENDPOINTS.global.path, { name: 'global' });

const categories = (limit = 100) =>
  call(`${ENDPOINTS.categories.path}?limit=${limit}`, { name: 'categories' });

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

// One category with its constituent coins. This is how the RWA view is built:
// the documented /v1/rwa/* endpoints all answer 404, but the tokenised asset
// taxonomy exists inside categories, so the data is reachable by another door.
const category = (id, limit = 100) =>
  call(`${ENDPOINTS.category.path}?id=${encodeURIComponent(id)}&limit=${limit}&convert=USD`, { name: `cat:${id}` });

const usage = () => ({
  calls: state.calls,
  creditsUsed: state.creditsUsed,
  refused: [...state.refused],
  lastError: state.lastError,
  uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
  hasKey: !!key(),
});

module.exports = {
  ENDPOINTS, call, usage,
  listings, globalMetrics, categories, fearGreed, platforms, trending, movers, dexGainers, dexNew,
  quotes, info, category,
};
