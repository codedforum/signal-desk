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

const PROTOCOL = '2024-11-05';

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
    case 'api_capability': {
      const checks = await Promise.all(Object.entries(cmc.ENDPOINTS).map(async ([n, e]) => {
        const isPost = e.method === 'POST';
        const r = await cmc.call(isPost ? e.path : `${e.path}?limit=1`, {
          method: e.method, body: isPost ? { time_period: '24h', limit: 1, type: 'gainer' } : null, name: `mcpcap:${n}`,
        });
        return { tool: n, endpoint: e.path, method: e.method, verdict: r.verdict };
      }));
      return {
        reachable: checks.filter((c) => c.verdict === 'ok').map((c) => c.endpoint),
        refusedByPlan: checks.filter((c) => c.verdict === 'plan').map((c) => c.endpoint),
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
