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
const { CATALOG } = require('./lib/cmc-catalog');
const signal = require('./lib/signal');
const { wrapperSpread } = require('./lib/spread');
const { isServed } = require('./lib/served');
const history = require('./lib/history');
const brain = require('./lib/brain');
const { PlatformMap } = require('./lib/platform');
const { num, usdQuote, rwaAssetRow, spreadBoard, withChains } = require('./lib/board');

const app = express();
const PORT = process.env.PORT || 3131;

// Chains worth calling out, because CMC covers long tail networks that the usual
// data vendors do not.
const HIGHLIGHT = (process.env.HIGHLIGHT_CHAINS || 'base,solana,fogo,robinhood,x layer')
  .split(',').map((s) => s.trim()).filter(Boolean);

// The v5 endpoints return the present and nothing else, and no number of
// credits buys last Tuesday. Recording the board on a timer is the only way to
// be able to say later whether today was unusual, so it starts on boot.
const hist = new history.SpreadHistory(
  process.env.HISTORY_FILE || path.join(__dirname, 'data', 'spread-history.jsonl'));
const HISTORY_WINDOW_DAYS = Math.min(
  Number(process.env.HISTORY_WINDOW_DAYS) || 30, history.RETAIN_DAYS);
// Matched to the upstream cache TTL, so a snapshot costs the two calls it
// already made rather than two more.
const RECORD_MS = Math.max(Number(process.env.RECORD_MS) || 15 * 60 * 1000, 60 * 1000);

// The question box runs on whatever inference is already sitting idle on this
// host. Unset BRAIN_BASE and the box reports itself unavailable rather than
// half working, because a dashboard that invents an answer is worse than one
// that declines to give one.
function brainFrom(prefix) {
  const base = process.env[`${prefix}_BASE`] || '';
  return base ? {
    base,
    model: process.env[`${prefix}_MODEL`] || 'gpt-oss:120b-cloud',
    key: process.env[`${prefix}_KEY`] || '',
    kind: process.env[`${prefix}_KIND`] || '',
  } : null;
}
// BRAIN_* is tried first, then BRAIN2_* and BRAIN3_*.
const BRAINS = ['BRAIN', 'BRAIN2', 'BRAIN3'].map(brainFrom).filter(Boolean);
const BRAIN = { enabled: BRAINS.length > 0, model: BRAINS.length ? BRAINS[0].model : null };
// Which chain each wrapper lives on. Cached on disk because a token's network
// does not change, so this costs a handful of calls once and nothing after.
const platforms = new PlatformMap(
  process.env.PLATFORM_FILE || path.join(__dirname, 'data', 'platforms.json'));

const askLimiter = new brain.RateLimiter(
  Number(process.env.ASK_PER_MIN) || 8, 60 * 1000);

app.use(express.json());

// This has to sit BEFORE the static handler. express.static answers a request
// it can satisfy rather than calling next(), so a check placed behind it never
// runs for exactly the files it is meant to catch.
app.use((req, res, next) => {
  if (isServed(req.path)) return next();
  res.status(404).type('text/plain').send('not found');
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

// Complete current CMC catalog. The UI can discover every documented route,
// including routes that need a paid plan or caller-supplied identifiers.
app.get('/api/catalog', (_req, res) => {
  res.json({
    ok: true,
    source: 'CoinMarketCap current Pro REST documentation',
    total: CATALOG.length,
    catalog: CATALOG,
    usage: cmc.usage(),
  });
});

// Execute a catalogued endpoint on demand. The path is whitelist-backed, so this
// cannot become an arbitrary outbound proxy. No automatic polling is attached:
// historical, DEX, holder, derivatives, content, AI and exchange routes can be
// used without burning credits on every dashboard refresh.
app.post('/api/catalog/call', async (req, res) => {
  const path = String(req.body?.path || '');
  const entry = CATALOG.find((e) => e.path === path);
  if (!entry) return res.status(404).json({ ok: false, error: 'path is not in the current CMC catalog' });
  const query = req.body?.query == null ? '' : String(req.body.query);
  const body = req.body?.body == null ? null : req.body.body;
  const r = await cmc.catalogCall(path, { query, body, name: `manual:${entry.method}:${path}:${query}` });
  res.status(r.status && r.status >= 400 ? r.status : 200).json({ ...r, path, method: entry.method, family: entry.family });
});

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
  // Resolve the ids the identifier-bearing probes need before firing any of them,
  // so an endpoint that works is not reported as a bad request.
  const ids = await cmc.probeIds();
  const checks = await Promise.all(
    Object.entries(cmc.ENDPOINTS).map(async ([name, e]) => {
      const base = { name, path: e.path, method: e.method, declaredTier: e.tier };
      if (e.method === 'POST') {
        const r = await cmc.call(e.path, {
          method: e.method,
          body: { time_period: '24h', limit: 1, type: 'gainer' },
          name: `cap:${name}`,
        });
        return { ...base, verdict: r.verdict, status: r.status };
      }
      const q = cmc.probeQuery(name, ids);
      if (q === null) return { ...base, verdict: 'skipped', status: 0 };
      const r = await cmc.call(`${e.path}${e.path.includes('?') ? '&' : '?'}${q}`, {
        method: e.method,
        name: `cap:${name}`,
      });
      return { ...base, verdict: r.verdict, status: r.status };
    })
  );
  const usable = checks.filter((c) => c.verdict === 'ok').map((c) => c.name);
  const gated = checks.filter((c) => c.verdict === 'plan').map((c) => c.name);
  const skipped = checks.filter((c) => c.verdict === 'skipped').map((c) => c.name);
  res.json({
    ok: true, usable, gated, skipped, checks,
    catalogTotal: CATALOG.length,
    catalog: CATALOG,
    // Declared means callable through /api/catalog/call; it is separate from
    // reachable because CMC plan gates and required parameters vary by account.
    declared: CATALOG.map((e) => e.path),
    usage: cmc.usage(),
  });
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

// `about` is an object carrying a markdown description, not a string.
const aboutText = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return String(v.description || v.text || '');
};

const firstUrl = (v) => (Array.isArray(v) ? v[0] : v) || '';

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

/* ============================ the question box ===========================
   Retrieve, then answer. The model chooses which of this app's own views to
   read and writes the sentence around it. It never supplies a number: every
   figure in an answer comes from the facts block, which is returned to the
   client alongside the prose so a reader can check one against the other. */

async function gatherFacts(intent, symbol, question) {
  const since = Math.floor(Date.now() / 1000) - HISTORY_WINDOW_DAYS * history.DAY;
  const withHistory = (r) => ({
    ...r, history: history.verdict(hist.series(r.id, since).map((x) => x.weighted), r.weightedSpreadBps),
  });

  // Whether the question names an asset is decided here, not by the model, and
  // it outranks the intent. Handing back the top ten when someone asked about
  // gold is how the answer "there is no tokenised gold" gets produced about an
  // asset that is sitting on the board.
  const board = (intent === 'spreads' || intent === 'asset' || intent === 'unknown')
    ? await spreadBoard(50, platforms) : null;
  const named = board && board.ok ? brain.resolveAsset(question, board.data, symbol) : null;

  // The plainest question there is. The app has had a quote endpoint all along,
  // but the router had no intent for it, so asking a price got "no price data".
  if (intent === 'quote') {
    const want = symbol || (String(question).toUpperCase().match(/\b[A-Z]{2,10}\b/g) || [])
      .filter((w) => !['WHAT', 'THE', 'IS', 'PRICE', 'CURRENT', 'HOW', 'MUCH', 'OF', 'NOW', 'TODAY'].includes(w))[0];
    if (!want) return { view: 'quote', error: 'no asset was named, so nothing was looked up' };
    const r = await cmc.quotes([want]);
    if (!r.ok) return { view: 'quote', askedAbout: want, error: 'the quote endpoint refused', verdict: r.verdict };
    const rows = Object.values(r.data || {}).map((c) => {
      const c0 = Array.isArray(c) ? c[0] : c;
      const u = (c0 && c0.quote && c0.quote.USD) || {};
      return {
        symbol: c0.symbol, name: c0.name, rank: c0.cmc_rank,
        price: u.price ?? null,
        change1h: u.percent_change_1h ?? null,
        change24h: u.percent_change_24h ?? null,
        change7d: u.percent_change_7d ?? null,
        volume24h: u.volume_24h ?? null,
        marketCap: u.market_cap ?? null,
      };
    });
    if (!rows.length) return { view: 'quote', askedAbout: want, error: `CoinMarketCap returned no asset for ${want}` };
    return { view: 'quote', askedAbout: want, note: 'change figures are percentages over that window', quotes: rows };
  }

  if (intent === 'spreads' && !named) {
    if (!board.ok) return { error: 'the spread board is unavailable', verdict: board.verdict };
    return {
      view: 'dislocation board',
      explains: 'weightedSpreadBps ranks by where volume actually trades; tradableSpreadBps is the outright gap',
      assetsScanned: board.scanned,
      assetsRankable: board.ranked,
      // The full roster, so an asset outside the top ten is known to exist
      // rather than reported as absent.
      allRankedSymbols: board.data.map((a) => a.symbol),
      mostDislocated: board.data.slice(0, 10).map(withHistory).map((a) => ({
        symbol: a.symbol, name: a.name, type: a.type,
        weightedSpreadBps: a.weightedSpreadBps, tradableSpreadBps: a.tradableSpreadBps,
        vwap: a.vwap, topVenueShare: a.concentration, liquidVolume24h: a.liquidVolume,
        cheapest: a.cheapest, dearest: a.dearest, history: a.history,
      })),
    };
  }

  if (intent === 'asset' || named) {
    const hit = named;
    if (!hit) {
      return {
        view: 'one asset',
        askedAbout: symbol || question,
        error: 'no asset on the board matches that, so nothing specific was fetched',
        availableSymbols: board && board.ok ? board.data.map((a) => a.symbol) : [],
      };
    }
    const detail = await cmc.rwaQuotes([hit.id]);
    const raw = cmc.rwaRows(detail.data, 'rwa_assets')[0] || {};
    const tokens = withChains((Array.isArray(raw.tokens) ? raw.tokens : []).map((t) => ({
      symbol: t.symbol || '', issuer: t.issuer_name || '',
      price: num(t.price), volume24h: num(t.volume_24h), cryptoId: t.crypto_id ?? null,
    })), platforms);
    const s = wrapperSpread(tokens, hit.reference);
    return {
      view: 'one asset',
      symbol: hit.symbol, name: hit.name, type: hit.type,
      referencePrice: hit.reference,
      weightedSpreadBps: hit.weightedSpreadBps, tradableSpreadBps: hit.tradableSpreadBps,
      vwap: hit.vwap, topVenueShare: hit.concentration, liquidVolume24h: hit.liquidVolume,
      history: withHistory(hit).history,
      wrappers: s ? s.rows.map((r) => ({
        symbol: r.symbol, issuer: r.issuer, price: r.price, volume24h: r.volume24h,
        chain: r.chain, publicChain: r.publicChain,
        liquidity: r.liquid ? 'liquid' : (r.thin ? 'thin' : 'none'),
        bpsFromBaseline: r.bpsFromBaseline,
      })) : [],
      differentUnit: s ? s.offScale.map((t) => ({ symbol: t.symbol, issuer: t.issuer, price: t.price })) : [],
    };
  }

  if (intent === 'regime') {
    const d = await signal.build({ highlightChains: HIGHLIGHT });
    return {
      view: 'market regime',
      regime: d.regime, breadth: d.breadth, sentiment: d.sentiment,
      global: d.global, topSectors: (d.sectors || []).slice(0, 8),
    };
  }

  if (intent === 'issuers') {
    const r = await cmc.rwaIssuers(100);
    if (!r.ok) return { error: 'the issuer list is unavailable', verdict: r.verdict };
    const rows = cmc.rwaRows(r.data, 'issuers')
      .map((i) => ({ name: i.name, tokens: i.num_tokens }))
      .sort((a, b) => (b.tokens || 0) - (a.tokens || 0));
    return {
      view: 'issuers',
      note: 'tokens is how many assets that issuer has tokenised; zero means registered but nothing indexed yet',
      total: rows.length,
      issuers: rows.slice(0, 25),
    };
  }

  if (intent === 'capability') {
    return {
      view: 'plan capability',
      note: 'this is what the key reached when each endpoint was last probed',
      creditsUsedThisProcess: cmc.usage().creditsUsed,
      callsThisProcess: cmc.usage().calls,
      refusedEndpoints: cmc.usage().refused,
      endpointsDeclared: Object.keys(cmc.ENDPOINTS).length,
    };
  }

  return {
    view: 'none',
    note: 'this desk answers questions about the crypto market regime, sector rotation, '
      + 'tokenised real world assets, the price gaps between their wrappers, the issuers '
      + 'who mint them, and what this API plan can reach. It has nothing else to hand.',
  };
}

// Whether this instance has a brain at all. The client hides the box rather
// than offering an input that answers nothing.
app.get('/api/ask-status', (_req, res) => {
  res.json({ ok: true, enabled: BRAIN.enabled, model: BRAIN.enabled ? BRAIN.model : null });
});

app.post('/api/ask', safe(async (req, res) => {
  const q = String((req.body && req.body.q) || '').trim().slice(0, 500);
  if (!q) return res.json({ ok: false, msg: 'ask a question' });
  if (!BRAIN.enabled) {
    return res.json({ ok: false, unavailable: true, msg: 'the question box is not configured on this instance' });
  }

  const who = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'anon';
  const gate = askLimiter.take(who);
  if (!gate.ok) {
    return res.status(429).json({ ok: false, msg: `too many questions, try again in ${gate.retryInSec}s` });
  }

  // 1. which of our own views answers this. The model picks, the keyword
  //    router decides when the model is unreachable or returns nonsense.
  const cls = await brain.chatAny(BRAINS, {
    system: brain.CLASSIFY_SYSTEM, user: q, timeoutMs: 15000, temperature: 0,
  });
  const routed = cls.ok ? brain.parseIntent(cls.content) : null;
  const intent = (routed && routed.intent) || brain.keywordIntent(q);
  const symbol = (routed && routed.symbol) || null;

  // 2. real data for that view, from the same functions the pages use.
  // Rounded before the model ever sees it, because a model repeats the precision
  // it is given and nobody needs a basis point to thirteen places.
  const gathered = brain.tidy(await gatherFacts(intent, symbol, q));
  // Stated rather than assumed. Without it a model reads liquidVolume24h as a
  // share count and writes "88.5 million shares" about a dollar figure.
  const facts = { units: brain.UNITS, ...gathered };

  // 3. prose over those facts and nothing else.
  const ans = await brain.chatAny(BRAINS, {
    system: brain.ANSWER_SYSTEM, user: brain.buildAnswerPrompt(q, facts),
    timeoutMs: 40000, temperature: 0.2,
  });

  if (!ans.ok) console.warn(`[cmc-signal] ask: every model failed, last: ${String(ans.msg).slice(0, 160)}`);
  res.json({
    ok: true,
    question: q,
    intent,
    symbol,
    routedBy: routed ? 'model' : 'keywords',
    answer: ans.ok ? brain.scrubAnswer(ans.content) : '',
    // Reported, never hidden. A box that silently falls back to a worse answer
    // teaches the reader to trust it more than they should.
    answerFailed: ans.ok ? null : brain.publicFailure(ans.msg),
    facts,
    usage: cmc.usage(),
  });
}));

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
  // Which on chain tokens actually represent this asset, and who minted each.
  // This is the join the category taxonomy cannot make: one real world asset
  // to many tokens, each with a named issuer.
  const tokens = withChains((Array.isArray(q.tokens) ? q.tokens : []).map((t) => ({
    symbol: t.symbol || '', name: t.name || '',
    price: num(t.price), marketCap: num(t.market_cap), volume24h: num(t.volume_24h),
    issuer: t.issuer_name || '', issuerId: t.issuer_id || '',
    cryptoId: t.crypto_id ?? null,
  })).sort((x, y) => (y.marketCap || 0) - (x.marketCap || 0)), platforms);
  const asset = {
    ...rwaAssetRow({ ...meta, ...q }),
    website: firstUrl(meta.website),
    industry: meta.industry || '',
    founded: meta.founded ?? null,
    employees: meta.employees ?? null,
    cik: meta.cik || '',
    about: aboutText(meta.about).replace(/#+\s*/g, '').slice(0, 600),
    logo: meta.logo || '',
  };
  const spread = wrapperSpread(tokens, asset.price);
  res.json({
    ok: true,
    data: asset,
    tokens,
    // Those same wrappers ranked by price. Issuers do not coordinate, so the
    // gap between the cheapest and the dearest is a real number about this
    // asset, and it costs no extra call to report it.
    spread: spread && {
      ...spread,
      // The same reading the board carries, so the modal and the leaderboard
      // never disagree about whether today is wide for this asset.
      history: history.verdict(
        hist.series(asset.id, Math.floor(Date.now() / 1000) - HISTORY_WINDOW_DAYS * history.DAY)
          .map((x) => x.weighted),
        spread.weightedSpreadBps),
    },
    // Reported, not hidden. A panel that silently omits a plan gated endpoint
    // teaches the reader nothing about why it is missing.
    marketPairs: pairs.ok ? cmc.rwaRows(pairs.data, 'market_pairs') : null,
    marketPairsVerdict: pairs.verdict,
  });
}));

// Which assets are priced most differently across the venues that tokenise them.
// quotes/latest takes up to 50 rwa_ids at once and returns the wrapper list for
// every one, so the whole leaderboard is two calls: the universe, then one
// batched quote. Both are cached for 15 minutes upstream, so the cost does not
// scale with viewers, only with time.
app.get('/api/rwa/spreads', safe(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 2), 50);
  const board = await spreadBoard(limit, platforms);
  if (!board.ok) return res.json(board);

  // Each row measured against its own past, which is the question a single
  // number cannot answer: 120 basis points is meaningless until you know
  // whether this asset usually sits at 30 or at 300.
  const since = Math.floor(Date.now() / 1000) - HISTORY_WINDOW_DAYS * history.DAY;
  for (const r of board.data) {
    const past = hist.series(r.id, since).map((p) => p.weighted);
    r.history = history.verdict(past, r.weightedSpreadBps);
  }

  res.json({ ...board, historyWindowDays: HISTORY_WINDOW_DAYS, usage: cmc.usage() });
}));

// The series behind that verdict, for one asset.
app.get('/api/rwa/spread-history/:id', safe(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || HISTORY_WINDOW_DAYS, 1), history.RETAIN_DAYS);
  const since = Math.floor(Date.now() / 1000) - days * history.DAY;
  const series = hist.series(req.params.id, since);
  res.json({
    ok: true,
    id: req.params.id,
    days,
    minReadings: history.MIN_READINGS,
    points: series.length,
    data: series,
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

// The chain lookup needs the crypto ids, which only the quotes payload carries,
// so it runs off a cheap board build and then fills whatever is missing. Guarded
// so two callers cannot fetch the same ids at once.
let filling = null;
async function fillPlatforms() {
  if (filling) return filling;
  filling = (async () => {
    try {
      // Both of these are the calls the board already makes, so they come from
      // the cache and the crypto ids cost nothing to collect.
      const list = await cmc.rwaAssets({ limit: 50 });
      if (!list.ok) return { fetched: 0, calls: 0, dropped: [] };
      const ids = cmc.rwaRows(list.data, 'rwa_assets').map((r) => r.rwa_id ?? r.id).filter(Boolean);
      const q = await cmc.rwaQuotes(ids);
      if (!q.ok) return { fetched: 0, calls: 0, dropped: [] };
      const cryptoIds = cmc.rwaRows(q.data, 'rwa_assets')
        .flatMap((a) => (a.tokens || []).map((t) => t.crypto_id))
        .filter(Boolean);
      const r = await platforms.fill(cmc, cryptoIds);
      if (r.fetched || r.dropped.length) {
        console.log(`[cmc-signal] chains: ${r.fetched} resolved in ${r.calls} calls`
          + (r.dropped.length ? `, ${r.dropped.length} ids the API rejected` : ''));
      }
      return r;
    } catch (e) {
      console.log(`[cmc-signal] chain lookup failed: ${e.message}`);
      return { fetched: 0, calls: 0, dropped: [] };
    } finally { filling = null; }
  })();
  return filling;
}

// Write down what the board looked like, because this reading is the only
// chance to record it. A failure here is logged and dropped: the recorder
// exists to make the product better later and must never be able to take the
// live site down now.
let recording = false;
async function recordSnapshot(reason) {
  if (recording) return;
  recording = true;
  try {
    // Resolve any wrapper chain not already known. Steady state this fetches
    // nothing, because a token's network does not change.
    await fillPlatforms();
    const board = await spreadBoard(50, platforms);
    if (!board.ok || !board.data.length) {
      console.log(`[cmc-signal] snapshot skipped (${reason}): ${board.verdict || 'no rows'}`);
      return;
    }
    const n = hist.append(board.data);
    console.log(`[cmc-signal] snapshot ${reason}: ${n} assets recorded`);
  } catch (e) {
    console.log(`[cmc-signal] snapshot failed (${reason}): ${e.message}`);
  } finally {
    recording = false;
  }
}

app.listen(PORT, () => {
  console.log(`[cmc-signal] listening on ${PORT}`);
  console.log(`[cmc-signal] key present: ${!!process.env.CMC_API_KEY}`);
  console.log(`[cmc-signal] highlight chains: ${HIGHLIGHT.join(', ')}`);
  console.log(`[cmc-signal] recording spreads every ${Math.round(RECORD_MS / 60000)}m to ${hist.file}`);

  if (process.env.RECORD_SPREADS === 'off') {
    console.log('[cmc-signal] spread recording disabled by RECORD_SPREADS=off');
    return;
  }
  // A short delay so a restart does not fire a snapshot before the process has
  // settled, and unref so the timer never holds the process open by itself.
  // Chains first, so the very first snapshot and the first page load already
  // know which network each wrapper is on.
  setTimeout(() => { fillPlatforms().then(() => recordSnapshot('boot')); }, 20 * 1000).unref();
  setInterval(() => recordSnapshot('timer'), RECORD_MS).unref();
  // Once a day, drop whatever has aged out of the window.
  setInterval(() => {
    try {
      const r = hist.prune();
      if (r.removed) console.log(`[cmc-signal] history pruned: ${r.removed} snapshots aged out`);
    } catch (e) { console.log(`[cmc-signal] prune failed: ${e.message}`); }
  }, 24 * 60 * 60 * 1000).unref();
});
