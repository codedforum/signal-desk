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

app.listen(PORT, () => {
  console.log(`[cmc-signal] listening on ${PORT}`);
  console.log(`[cmc-signal] key present: ${!!process.env.CMC_API_KEY}`);
  console.log(`[cmc-signal] highlight chains: ${HIGHLIGHT.join(', ')}`);
});
