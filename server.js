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

// Real world assets. The documented /v1/rwa/* endpoints answer 404 on every path
// tried, but the tokenised asset taxonomy is present inside categories, so the
// sector is reachable through that door instead. These ids were read from a live
// categories call, not guessed.
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

app.get('/api/rwa', async (_req, res) => {
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
    } : { id, label, tokens: 0, marketCap: 0, change24h: 0, volume24h: 0, missing: true };
  }).filter((r) => !r.missing);
  res.json({ ok: cats.ok, verdict: cats.verdict, data: out, usage: cmc.usage() });
});

// Constituents of one RWA category.
app.get('/api/rwa/:id', async (req, res) => {
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
});

app.listen(PORT, () => {
  console.log(`[cmc-signal] listening on ${PORT}`);
  console.log(`[cmc-signal] key present: ${!!process.env.CMC_API_KEY}`);
  console.log(`[cmc-signal] highlight chains: ${HIGHLIGHT.join(', ')}`);
});
