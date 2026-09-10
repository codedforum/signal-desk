'use strict';
// cmc-signal, a market regime and rotation desk built on the CoinMarketCap API.
//
// Design note that matters for anyone reading this cold: the free CMC tier
// refuses most interesting endpoints with a 403. Rather than fail, every route
// reports which endpoints it reached and which the plan refused, and the client
// draws the difference. So the product is honest on a free key and gets wider,
// not different, on a paid one.

require('dotenv').config();
const express = require('express');
const path = require('path');
const cmc = require('./lib/cmc');
const signal = require('./lib/signal');

const app = express();
const PORT = process.env.PORT || 3131;

// Chains worth calling out, because CMC covers long tail networks that the usual
// data vendors do not.
const HIGHLIGHT = (process.env.HIGHLIGHT_CHAINS || 'base,solana,fogo,robinhood,x layer')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'cmc-signal', at: new Date().toISOString(), usage: cmc.usage() });
});

// The whole desk in one call, so the client does not fan out and the cache is hit once.
app.get('/api/signal', async (_req, res) => {
  try {
    const data = await signal.build({ highlightChains: HIGHLIGHT });
    res.json({ ok: true, ...data, usage: cmc.usage() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

// What this key can actually do. Exposed rather than hidden because it is the
// honest answer to "why is that panel empty", and because a submission is asked
// to name the endpoints it uses.
app.get('/api/capability', async (_req, res) => {
  const checks = await Promise.all(
    Object.entries(cmc.ENDPOINTS).map(async ([name, e]) => {
      const isPost = e.method === 'POST';
      const r = await cmc.call(isPost ? e.path : `${e.path}${e.path.includes('?') ? '&' : '?'}limit=1`, {
        method: e.method,
        body: isPost ? { time_period: '24h', limit: 1, type: 'gainer' } : null,
        name: `cap:${name}`,
      });
      return { name, path: e.path, method: e.method, declaredTier: e.tier, verdict: r.verdict, status: r.status };
    })
  );
  const usable = checks.filter((c) => c.verdict === 'ok').map((c) => c.name);
  const gated = checks.filter((c) => c.verdict === 'plan').map((c) => c.name);
  res.json({ ok: true, usable, gated, checks, usage: cmc.usage() });
});

// Paid-tier extras. Each returns its verdict so the UI can say "your plan does
// not include this" instead of showing an empty box.
app.get('/api/extra/:what', async (req, res) => {
  const map = { trending: cmc.trending, movers: cmc.movers, dexGainers: cmc.dexGainers, dexNew: cmc.dexNew };
  const fn = map[req.params.what];
  if (!fn) return res.status(404).json({ ok: false, error: 'unknown feed' });
  const r = await fn();
  res.json({ ok: r.ok, verdict: r.verdict, status: r.status, msg: r.msg, data: r.data });
});

// Lookup and watchlist. Both ride /v1/cryptocurrency/quotes/latest, which is free
// and costs one credit per call no matter how many symbols, so the watchlist is
// deliberately batched into a single request.
app.get('/api/quote', async (req, res) => {
  const syms = String(req.query.symbol || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!syms.length) return res.status(400).json({ ok: false, error: 'symbol required' });
  const r = await cmc.quotes(syms);
  if (!r.ok) return res.json({ ok: false, verdict: r.verdict, msg: r.msg, data: null });
  const out = Object.values(r.data || {}).map((c) => {
    const q = (Array.isArray(c) ? c[0] : c);
    const u = q?.quote?.USD || {};
    return {
      id: q.id, symbol: q.symbol, name: q.name, rank: q.cmc_rank,
      price: u.price ?? null,
      change1h: u.percent_change_1h ?? null,
      change24h: u.percent_change_24h ?? null,
      change7d: u.percent_change_7d ?? null,
      change30d: u.percent_change_30d ?? null,
      volume24h: u.volume_24h ?? null,
      marketCap: u.market_cap ?? null,
      supply: q.circulating_supply ?? null,
      maxSupply: q.max_supply ?? null,
    };
  });
  res.json({ ok: true, data: out, usage: cmc.usage() });
});

// Full network list, for the searchable chain view.
app.get('/api/chains', async (_req, res) => {
  const r = await cmc.platforms();
  if (!r.ok) return res.json({ ok: false, verdict: r.verdict, data: [] });
  const rows = (r.data || []).map((x) => ({
    id: x.id, name: x.n || x.dn || '', short: x.dn || '', chainId: x.chId ?? null, explorer: x.uf || '',
  })).filter((x) => x.name).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ ok: true, total: rows.length, data: rows });
});

// Real world assets, built on the v5 family.
//
// A note that cost real time: these live at /v5/real-world-assets/*, not under a
// v1 path. Guessing the version from the rest of the API gives 404 on every path
// and reads like the endpoints do not exist. Six of the seven are on the free
// tier; only market-pairs is plan gated, and that is reported rather than hidden.
//
// The categories view below is kept alongside, because it answers a different
// question: v5 tells you about an asset and its issuer, categories tells you how
// the tokenised sectors compare by market cap.
const RWA_CATEGORIES = [
  { id: '6400b58c1701313dc2e853a9', label: 'Real World Assets Protocols' },
  { id: '68639a79358e0763b448bf51', label: 'Tokenized ETFs' },
  { id: '6a8f9cb3246a6f3c6e2d9040', label: 'Robinhood Stock' },
  { id: '6a2bd5c097c45356b1a61372', label: 'bStocks' },
  { id: '68639a4f358e0763b448bf0c', label: 'Tokenized commodities' },
  { id: '625d09d246203827ab52dd53', label: 'Tokenized Gold' },
  { id: '68639aa7358e0763b448bf8a', label: 'Tokenized Treasury Bills' },
  { id: '68639b08358e0763b448c036', label: 'Tokenized Treasury Bonds' },
  { id: '6051a81466fc1b42617d6daf', label: 'Real Estate' },
];

// An async handler that throws never calls res, so Express holds the socket open
// and the browser hangs until it times out. That is how an object where a string
// was expected turned into a 50 second stall with no error reaching the client.
// Every async route below is wrapped so a bad upstream shape becomes a 500 with a
// logged reason instead of silence.
const safe = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[route]', req.path, e.message);
  if (!res.headersSent) res.status(500).json({ ok: false, error: 'handler failed', detail: e.message });
});

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

// `about` is an object carrying a markdown description, not a string.
const aboutText = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return String(v.description || v.text || '');
};

const firstUrl = (v) => (Array.isArray(v) ? v[0] : v) || '';

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

// Asset types that actually return rows. Probed once at boot rather than pinned,
// because a hardcoded list of upstream types goes stale the moment CMC adds one.
let rwaTypeCache = null;
async function liveRwaTypes() {
  if (rwaTypeCache && Date.now() - rwaTypeCache.at < 60 * 60 * 1000) return rwaTypeCache.types;
  const results = await Promise.all(cmc.RWA_TYPES.map(async (t) => {
    const r = await cmc.rwaAssets({ type: t, limit: 1 });
    return { type: t, n: cmc.rwaRows(r.data, 'rwa_assets').length, ok: r.ok };
  }));
  const types = results.filter((x) => x.ok && x.n > 0).map((x) => x.type);
  rwaTypeCache = { at: Date.now(), types };
  return types;
}

app.get('/api/rwa/types', safe(async (_req, res) => {
  res.json({ ok: true, all: cmc.RWA_TYPES, populated: await liveRwaTypes() });
}));

app.get('/api/rwa/assets', safe(async (req, res) => {
  const type = String(req.query.type || '');
  const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 250);
  const r = await cmc.rwaAssets({ type, limit });
  if (!r.ok) return res.json({ ok: false, verdict: r.verdict, msg: r.msg, data: [] });
  const rows = cmc.rwaRows(r.data, 'rwa_assets').map(rwaAssetRow);
  res.json({
    ok: true, total: r.data?.total_size ?? rows.length, type,
    data: rows, usage: cmc.usage(),
  });
}));

// One asset: metadata and quote together. The metadata is the reason this view
// exists at all, because it carries the registrant behind the token, including
// the SEC CIK for an equity. Nothing in the categories data reaches that.
app.get('/api/rwa/asset/:id', safe(async (req, res) => {
  const id = req.params.id;
  const [info, quote, pairs] = await Promise.all([
    cmc.rwaInfo([id]), cmc.rwaQuotes([id]), cmc.rwaPairs(id, 10),
  ]);
  if (!info.ok && !quote.ok) {
    return res.json({ ok: false, verdict: info.verdict, msg: info.msg, data: null });
  }
  const meta = cmc.rwaRows(info.data, 'rwa_assets')[0] || {};
  const q = cmc.rwaRows(quote.data, 'rwa_assets')[0] || {};
  res.json({
    ok: true,
    data: {
      ...rwaAssetRow({ ...meta, ...q }),
      website: firstUrl(meta.website),
      industry: meta.industry || '',
      founded: meta.founded ?? null,
      employees: meta.employees ?? null,
      cik: meta.cik || '',
      about: aboutText(meta.about).replace(/#+\s*/g, '').slice(0, 600),
      logo: meta.logo || '',
    },
    // Which on chain tokens actually represent this asset, and who minted each.
    // This is the join the category taxonomy cannot make: one real world asset
    // to many tokens, each with a named issuer.
    tokens: (Array.isArray(q.tokens) ? q.tokens : []).map((t) => ({
      symbol: t.symbol || '', name: t.name || '',
      price: num(t.price), marketCap: num(t.market_cap), volume24h: num(t.volume_24h),
      issuer: t.issuer_name || '', issuerId: t.issuer_id || '',
    })).sort((x, y) => (y.marketCap || 0) - (x.marketCap || 0)),
    // Reported, not hidden. A panel that silently omits a plan gated endpoint
    // teaches the reader nothing about why it is missing.
    marketPairs: pairs.ok ? cmc.rwaRows(pairs.data, 'market_pairs') : null,
    marketPairsVerdict: pairs.verdict,
  });
}));

app.get('/api/rwa/issuers', safe(async (_req, res) => {
  const r = await cmc.rwaIssuers(100);
  if (!r.ok) return res.json({ ok: false, verdict: r.verdict, msg: r.msg, data: [] });
  const rows = cmc.rwaRows(r.data, 'issuers').map((i) => ({
    id: i.issuer_id ?? i.id,
    name: i.name || '',
    website: Array.isArray(i.website) ? i.website[0] : i.website || '',
    logo: i.logo || '',
    tokens: i.num_tokens ?? 0,
  })).sort((a, b) => (b.tokens || 0) - (a.tokens || 0));
  res.json({ ok: true, total: rows.length, data: rows, usage: cmc.usage() });
}));

// One issuer and everything it has tokenised. This is the issuer explorer: it
// inverts the question from "what is this token" to "who minted it, and what
// else have they minted", which the category taxonomy cannot answer.
app.get('/api/rwa/issuer/:id', safe(async (req, res) => {
  const r = await cmc.rwaIssuer(req.params.id, 100);
  if (!r.ok) return res.json({ ok: false, verdict: r.verdict, msg: r.msg, data: null });
  const d = r.data || {};
  // The issuer token list carries identity only: name, symbol and the ids that
  // link back. No price and no network, so the table shows what exists rather
  // than empty columns, and the rwa_id makes each row open the asset detail.
  const tokens = (Array.isArray(d.tokens) ? d.tokens : cmc.rwaRows(d, 'tokens')).map((t) => ({
    name: t.name || '', symbol: t.symbol || '',
    rwaId: t.rwa_id ?? null, cryptoId: t.crypto_id ?? null,
  }));
  res.json({
    ok: true,
    data: {
      id: d.issuer_id ?? req.params.id,
      name: d.name || '',
      website: firstUrl(d.website),
      logo: d.logo || '',
      tokens: d.num_tokens ?? tokens.length,
    },
    tokens,
  });
}));

// Tokenised sectors by market cap, from categories.
app.get('/api/rwa/sectors', safe(async (_req, res) => {
  const cats = await cmc.categories(5000);
  const byId = new Map((cats.data || []).map((c) => [c.id, c]));
  const out = RWA_CATEGORIES.map(({ id, label }) => {
    const c = byId.get(id);
    return c ? {
      id, label,
      tokens: c.num_tokens ?? 0,
      marketCap: Number(c.market_cap || 0),
      change24h: +Number(c.market_cap_change || 0).toFixed(2),
      volume24h: Number(c.volume || 0),
    } : { id, label, missing: true };
  }).filter((r) => !r.missing);
  res.json({ ok: cats.ok, verdict: cats.verdict, data: out, usage: cmc.usage() });
}));

// Constituents of one tokenised sector.
app.get('/api/rwa/sector/:id', safe(async (req, res) => {
  const r = await cmc.category(req.params.id, 60);
  if (!r.ok) return res.json({ ok: false, verdict: r.verdict, msg: r.msg, data: null });
  const coins = (r.data?.coins || []).map((c) => ({
    id: c.id, symbol: c.symbol, name: c.name, rank: c.cmc_rank,
    price: c.quote?.USD?.price ?? null,
    change24h: +Number(c.quote?.USD?.percent_change_24h ?? 0).toFixed(2),
    change7d: +Number(c.quote?.USD?.percent_change_7d ?? 0).toFixed(2),
    marketCap: c.quote?.USD?.market_cap ?? null,
    volume24h: c.quote?.USD?.volume_24h ?? null,
  })).sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  res.json({ ok: true, name: r.data?.name || '', description: (r.data?.description || '').slice(0, 400), data: coins });
}));

app.listen(PORT, () => {
  console.log(`[cmc-signal] listening on ${PORT}`);
  console.log(`[cmc-signal] key present: ${!!process.env.CMC_API_KEY}`);
  console.log(`[cmc-signal] highlight chains: ${HIGHLIGHT.join(', ')}`);
});
