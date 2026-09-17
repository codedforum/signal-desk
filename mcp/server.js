#!/usr/bin/env node
'use strict';
// Signal Desk MCP server.
//
// Puts live CoinMarketCap data in front of any LLM that speaks MCP, over stdio.
// The tools are deliberately the ANALYSIS, not thin endpoint wrappers: a model
// asking "what is the market doing" wants a regime read and a breadth number,
// not 200 rows of JSON it has to reduce itself. Handing a model raw listings
// burns its context and invites it to do arithmetic badly.
//
// Every tool reports whether the plan refused an endpoint, so the model can say
// "that needs a paid key" instead of inventing an answer.
//
//   claude mcp add signal-desk -- node /path/to/mcp/server.js
//   or add to any MCP client config with CMC_API_KEY in the environment.

require('dotenv').config();
const cmc = require('../lib/cmc');
const sig = require('../lib/signal');
const { wrapperSpread } = require('../lib/spread');

const PROTOCOL = '2024-11-05';

// A model reasons better over a short number than a full float, and reads a
// named wrapper faster than a row it has to index into.
const round1 = (n) => (n == null || !isFinite(n)) ? null : Math.round(n * 10) / 10;
const round2 = (n) => (n == null || !isFinite(n)) ? null : Math.round(n * 100) / 100;
const brief = (t) => t ? { symbol: t.symbol, issuer: t.issuer, price: t.price } : null;

const TOOLS = [
  {
    name: 'market_regime',
    description:
      'Is the crypto market taking risk or reducing it right now. Returns a stance, the reasoning, total market cap, ' +
      'BTC and ETH dominance, the fear and greed reading, and whether sentiment currently disagrees with market breadth. ' +
      'Use this for "how is the market", "what is the mood", "is it risk on".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'market_breadth',
    description:
      'How much of the market is actually participating, measured across the top N assets by market cap. Returns the ' +
      'advancing count, participation percentage, the median 24h move, and counts of assets up or down more than 5 percent. ' +
      'Use this when a headline index move might be hiding what most assets did.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many top assets to sample, 10 to 500. Default 200.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'sector_rotation',
    description:
      'Which market sectors money rotated into or out of over the last 24 hours, ranked by capital weighted change. ' +
      'Returns sector name, token count, market cap and 24h change. Use for "what is hot", "which sectors are moving".',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many sectors to return. Default 12.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'quote',
    description:
      'Live price and performance for one or more assets by ticker symbol. Returns price, 1h, 24h, 7d and 30d change, ' +
      'volume, market cap and supply. Batched, so asking for several symbols at once costs a single API credit.',
    inputSchema: {
      type: 'object',
      properties: { symbols: { type: 'array', items: { type: 'string' }, description: 'Ticker symbols, for example ["BTC","ETH"].' } },
      required: ['symbols'],
      additionalProperties: false,
    },
  },
  {
    name: 'chain_coverage',
    description:
      'Which blockchain networks CoinMarketCap indexes for on-chain DEX data, and the platform id for each. Useful for ' +
      'checking whether a long tail chain such as Fogo, Robinhood Chain or X Layer has coverage before building against it.',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Optional filter, for example "base" or "fogo".' } },
      additionalProperties: false,
    },
  },
  {
    name: 'rwa_assets',
    description:
      'Tokenised real world assets indexed by CoinMarketCap: equities, commodities and funds that exist on chain. ' +
      'Returns symbol, name, asset type, tokenised price, tokenised market cap and 24h tokenised volume, ranked by ' +
      'tokenised market cap. Use for "what stocks are tokenised", "tokenised gold", "RWA market".',
    inputSchema: {
      type: 'object',
      properties: {
        asset_type: { type: 'string', description: 'Optional filter. Populated today: stock, commodity, etf.' },
        limit: { type: 'number', description: 'How many assets, 1 to 250. Default 25.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'rwa_asset',
    description:
      'One tokenised real world asset in full: the registrant behind it (industry, founded, employees, SEC CIK, website) ' +
      'and every on-chain token representing it with the issuer that minted each one. Issuers do not coordinate, so the ' +
      'same asset carries a different price on each wrapper, and this returns that dispersion ranked in basis points. ' +
      'Use this to answer "who issues tokenised NVDA", "what company is behind this token", "which version of tokenised ' +
      'gold is largest", "where is tokenised CRCL cheapest right now", "how far apart are the wrappers on this asset".',
    inputSchema: {
      type: 'object',
      properties: { rwa_id: { type: 'number', description: 'The rwa_id from rwa_assets.' } },
      required: ['rwa_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'rwa_issuers',
    description:
      'Who mints tokenised real world assets, and how many each has issued. Optionally drills into one issuer to list ' +
      'everything it has tokenised. Use for "who issues tokenised stocks", "what else has Backed Assets minted".',
    inputSchema: {
      type: 'object',
      properties: { issuer_id: { type: 'string', description: 'Optional. Omit for the ranked issuer list.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'api_capability',
    description:
      'What the configured CoinMarketCap key can actually reach, probed live against the API. Returns which endpoints are ' +
      'reachable and which the subscription plan refuses. Call this before telling a user a data point is unavailable, ' +
      'so the answer distinguishes a plan limit from a real absence.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function runTool(name, args = {}) {
  switch (name) {
    case 'market_regime': {
      const [g, fg, list] = await Promise.all([cmc.globalMetrics(), cmc.fearGreed(), cmc.listings(200)]);
      if (!g.ok) return { error: `global metrics unavailable (${g.verdict})`, detail: g.msg };
      const fgData = Array.isArray(fg.data) ? fg.data[0] : fg.data;
      const regime = sig.regimeFrom(g.data, fgData);
      const breadth = sig.breadthFrom(Array.isArray(list.data) ? list.data : []);
      let divergence = null;
      if (regime.fearGreed && breadth) {
        if (regime.fearGreed >= 60 && breadth.advancePct <= 35) {
          divergence = `Sentiment reads ${regime.fearGreedLabel} at ${regime.fearGreed} but only ${breadth.advancePct}% of the top ${breadth.sampled} is advancing. Mood and participation disagree.`;
        } else if (regime.fearGreed <= 40 && breadth.advancePct >= 65) {
          divergence = `Sentiment reads ${regime.fearGreedLabel} at ${regime.fearGreed} while ${breadth.advancePct}% is advancing. Participation is better than the mood suggests.`;
        }
      }
      return { ...regime, breadth, divergence, source: 'coinmarketcap' };
    }
    case 'market_breadth': {
      const list = await cmc.listings(Math.min(Math.max(Number(args.limit) || 200, 10), 500));
      if (!list.ok) return { error: `listings unavailable (${list.verdict})`, detail: list.msg };
      return sig.breadthFrom(list.data) || { error: 'no rows returned' };
    }
    case 'sector_rotation': {
      const cats = await cmc.categories(200);
      if (!cats.ok) return { error: `categories unavailable (${cats.verdict})`, detail: cats.msg };
      return { sectors: sig.rotationFrom(cats.data, Number(args.limit) || 12) };
    }
    case 'quote': {
      const syms = Array.isArray(args.symbols) ? args.symbols : [];
      if (!syms.length) return { error: 'symbols is required' };
      const r = await cmc.quotes(syms);
      if (!r.ok) return { error: `quotes unavailable (${r.verdict})`, detail: r.msg };
      return {
        assets: Object.values(r.data || {}).map((c) => {
          const q = Array.isArray(c) ? c[0] : c;
          const u = q?.quote?.USD || {};
          return {
            symbol: q.symbol, name: q.name, rank: q.cmc_rank, price: u.price,
            change1h: u.percent_change_1h, change24h: u.percent_change_24h,
            change7d: u.percent_change_7d, change30d: u.percent_change_30d,
            volume24h: u.volume_24h, marketCap: u.market_cap,
          };
        }),
      };
    }
    case 'chain_coverage': {
      const r = await cmc.platforms();
      if (!r.ok) return { error: `platform list unavailable (${r.verdict})`, detail: r.msg };
      const rows = (r.data || []).map((x) => ({ id: x.id, name: x.n || x.dn || '', chainId: x.chId ?? null }));
      const q = String(args.search || '').toLowerCase();
      const out = q ? rows.filter((x) => x.name.toLowerCase().includes(q)) : rows;
      return { total: rows.length, matched: out.length, networks: out.slice(0, 60) };
    }
    case 'rwa_assets': {
      const r = await cmc.rwaAssets({
        type: String(args.asset_type || ''),
        limit: Math.min(Math.max(Number(args.limit) || 25, 1), 250),
      });
      if (!r.ok) return { error: `rwa assets unavailable (${r.verdict})`, detail: r.msg };
      const rows = cmc.rwaRows(r.data, 'rwa_assets');
      return {
        total: r.data?.total_size ?? rows.length,
        assets: rows.map((a) => {
          const q = Array.isArray(a.quotes) ? (a.quotes.find((x) => (x.symbol || '').toUpperCase() === 'USD') || a.quotes[0] || {}) : {};
          return {
            rwa_id: a.rwa_id, symbol: a.symbol, name: a.name, assetType: a.asset_type, rank: a.rwa_rank,
            tokenizedPrice: q.average_tokenized_price ?? a.average_tokenized_price,
            tokenizedMarketCap: q.tokenized_market_cap ?? a.tokenized_market_cap,
            tokenizedVolume24h: q.tokenized_volume_24h ?? a.tokenized_volume_24h,
          };
        }),
      };
    }
    case 'rwa_asset': {
      const id = Number(args.rwa_id);
      if (!id) return { error: 'rwa_id is required' };
      const [info, quote] = await Promise.all([cmc.rwaInfo([id]), cmc.rwaQuotes([id])]);
      const meta = cmc.rwaRows(info.data, 'rwa_assets')[0];
      const q = cmc.rwaRows(quote.data, 'rwa_assets')[0];
      if (!meta && !q) return { error: `rwa asset ${id} unavailable (${info.verdict})`, detail: info.msg };
      const usd = Array.isArray(q?.quotes) ? (q.quotes.find((x) => (x.symbol || '').toUpperCase() === 'USD') || q.quotes[0] || {}) : {};
      const about = meta?.about;
      const tokens = (q?.tokens || []).map((t) => ({
        symbol: t.symbol, name: t.name, issuer: t.issuer_name, issuerId: t.issuer_id,
        price: t.price, marketCap: t.market_cap, volume24h: t.volume_24h,
      })).sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
      const reference = usd.average_tokenized_price ?? q?.average_tokenized_price;
      const spread = wrapperSpread(tokens, reference);
      // wrapperSpread returns copies, so the ranking is matched back by the pair
      // that identifies a wrapper. One asset can carry the same symbol twice,
      // as Robinhood and a derivatives venue both do, which is why the issuer
      // has to be part of the key and the symbol alone will not do.
      const key = (t) => `${t.symbol}\u0000${t.issuerId}`;
      const ranked = new Map((spread ? spread.rows : []).map((r) => [key(r), r]));
      return {
        rwa_id: id,
        symbol: meta?.symbol || q?.symbol, name: meta?.name || q?.name,
        assetType: q?.asset_type, industry: meta?.industry || null,
        founded: meta?.founded || null, employees: meta?.employees || null,
        secCik: meta?.cik || null,
        website: Array.isArray(meta?.website) ? meta.website[0] : meta?.website || null,
        about: (typeof about === 'string' ? about : about?.description || '').replace(/#+\s*/g, '').slice(0, 500) || null,
        tokenizedPrice: usd.average_tokenized_price ?? q?.average_tokenized_price,
        tokenizedMarketCap: usd.tokenized_market_cap ?? q?.tokenized_market_cap,
        // The join a model cannot make on its own: one asset, many issuers.
        tokens: tokens.map((t) => {
          // A token with no live quote is absent from the ranking, and says so
          // with a null rather than a zero that would read as "on the money".
          const r = ranked.get(key(t));
          return {
            ...t,
            bpsFromBaseline: r ? round1(r.bpsFromBaseline) : null,
            premiumPct: r ? round2(r.premiumPct) : null,
            // Absent from the ranking means one of two things, and they are
            // not the same: no live quote, or a quote on another unit.
            rankable: r ? true : false,
            // Three states, not two. Liquid is tradable, thin is traded by
            // almost nobody, and neither of the last two is evidence of a price.
            liquidity: r ? (r.liquid ? 'liquid' : (r.thin ? 'thin' : 'none')) : null,
          };
        }),
        spread: spread && {
          wrappers: spread.count,
          unpriced: spread.unpriced,
          referencePrice: spread.reference,
          spreadBps: round1(spread.spreadBps),
          cheapest: brief(spread.cheapest),
          dearest: brief(spread.dearest),
          // Everything is measured from here, and it is the cheapest wrapper
          // that trades rather than the cheapest quote.
          baseline: brief(spread.baseline),
          // Same asset, different unit, so these are named and never ranked.
          offScale: spread.offScale.map((t) => ({
            ...brief(t), ratioToAnchor: round2(t.ratioToAnchor),
          })),
          // Only these two can actually be traded against each other, so a
          // recommendation should quote this pair and not the one above.
          tradableSpreadBps: spread.tradableSpreadBps == null ? null : round1(spread.tradableSpreadBps),
          tradableCheapest: brief(spread.tradableCheapest),
          tradableDearest: brief(spread.tradableDearest),
          caveat: 'Wrappers differ by chain, custody and redemption terms, so a gap is a venue '
            + 'cost rather than an arbitrage. Say so when quoting one. A wrapper with no volume '
            + 'is a published price, not an available one, and anything in offScale quotes a '
            + 'different unit of the asset and must never be called cheap. Quote tradableSpreadBps, '
            + 'never spreadBps, when a user asks how dislocated an asset is: the second includes '
            + 'venues under the liquidity floor whose prices drift and stay drifted.',
        },
      };
    }
    case 'rwa_issuers': {
      if (args.issuer_id) {
        const r = await cmc.rwaIssuer(String(args.issuer_id), 100);
        if (!r.ok) return { error: `issuer unavailable (${r.verdict})`, detail: r.msg };
        const d = r.data || {};
        return {
          issuer: d.name, issuer_id: d.issuer_id, total: d.num_tokens,
          website: Array.isArray(d.website) ? d.website[0] : d.website || null,
          tokens: (d.tokens || []).map((t) => ({ symbol: t.symbol, name: t.name, rwa_id: t.rwa_id })),
        };
      }
      const r = await cmc.rwaIssuers(100);
      if (!r.ok) return { error: `issuers unavailable (${r.verdict})`, detail: r.msg };
      return {
        issuers: cmc.rwaRows(r.data, 'issuers')
          .map((i) => ({ issuer_id: i.issuer_id, name: i.name, tokens: i.num_tokens }))
          .sort((a, b) => (b.tokens || 0) - (a.tokens || 0)),
      };
    }
    case 'api_capability': {
      // Same probe rules as the HTTP capability route: an endpoint that needs an
      // identifier is called with one, so a working endpoint is never reported
      // to the model as a bad request.
      const ids = await cmc.probeIds();
      const checks = await Promise.all(Object.entries(cmc.ENDPOINTS).map(async ([n, e]) => {
        if (e.method === 'POST') {
          const r = await cmc.call(e.path, {
            method: e.method, body: { time_period: '24h', limit: 1, type: 'gainer' }, name: `mcpcap:${n}`,
          });
          return { tool: n, endpoint: e.path, method: e.method, verdict: r.verdict };
        }
        const q = cmc.probeQuery(n, ids);
        if (q === null) return { tool: n, endpoint: e.path, method: e.method, verdict: 'skipped' };
        const r = await cmc.call(`${e.path}${e.path.includes('?') ? '&' : '?'}${q}`, {
          method: e.method, name: `mcpcap:${n}`,
        });
        return { tool: n, endpoint: e.path, method: e.method, verdict: r.verdict };
      }));
      return {
        reachable: checks.filter((c) => c.verdict === 'ok').map((c) => c.endpoint),
        refusedByPlan: checks.filter((c) => c.verdict === 'plan').map((c) => c.endpoint),
        notProbed: checks.filter((c) => c.verdict === 'skipped').map((c) => c.endpoint),
        checks,
      };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

/* --------------------------- stdio JSON-RPC --------------------------- */

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'signal-desk', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const tool = params?.name;
    try {
      const out = await runTool(tool, params?.arguments || {});
      // Text content, because every MCP client renders it and a model reads JSON
      // in a text block perfectly well.
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: !!out?.error });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: `tool ${tool} failed: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    handle(req).catch((e) => { if (req?.id !== undefined) fail(req.id, -32603, String(e.message)); });
  }
});

process.stderr.write(`[signal-desk mcp] ready, ${TOOLS.length} tools, key ${process.env.CMC_API_KEY ? 'present' : 'MISSING'}\n`);
