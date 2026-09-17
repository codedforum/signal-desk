'use strict';
// The question box.
//
// The whole point of this product is that every number came from a live call,
// so a language model is allowed to choose WHAT to look up and to write the
// sentence around it. It is never allowed to supply the number. The flow is
// retrieve then answer: classify the question, fetch real data for that intent,
// and hand the model only that payload with instructions to work from it alone.
//
// Every answer ships with the facts it was built from, so a reader can check
// the prose against the data rather than trusting it.

const INTENTS = ['quote', 'spreads', 'asset', 'regime', 'issuers', 'capability', 'unknown'];

// Shipped with every payload. A number with no unit gets one invented for it.
const UNITS = 'every price and volume is US dollars, never a share count. '
  + 'bps figures are basis points, where 100 bps is one percent. '
  + 'share and concentration figures are fractions of 1, so 0.46 is 46 percent.';

// Deterministic router, used when the model is unreachable and as the sanity
// check on what it returns. A keyword rule that is sometimes coarse beats a
// model that is occasionally confident and wrong about which data to fetch.
function keywordIntent(question) {
  const q = String(question || '').toLowerCase();
  if (/\b(plan|credit|endpoint|paid|free tier|refus|api key|capab)/.test(q)) return 'capability';
  // The plainest question anyone asks a market dashboard, so it is checked
  // before the wordier intents can claim it.
  if (/\b(price|worth|trading at|cost|quote|how much is|market cap|mcap|up or down)\b/.test(q)
      && !/\b(spread|dislocat|wrapper|venue|cheapest across)/.test(q)) return 'quote';
  if (/\b(issuer|issued by|who mint|who issues|backed assets|ondo|bstocks|paxos|robinhood)\b/.test(q)) return 'issuers';
  if (/\b(spread|dislocat|cheapest|dearest|wrapper|arbitrag|venue|premium|wide|gap)/.test(q)) return 'spreads';
  if (/\b(regime|breadth|sentiment|fear|greed|market doing|risk on|risk off|rotation|sector)/.test(q)) return 'regime';
  if (/\b(tokenis|tokeniz|rwa|stock|equity|gold|silver|etf|treasur)/.test(q)) return 'asset';
  return 'unknown';
}

// The model answers with JSON. It is parsed defensively because a model that
// wraps its JSON in prose or a code fence is the normal case, not the odd one.
function parseIntent(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const intent = INTENTS.includes(obj.intent) ? obj.intent : null;
  if (!intent) return null;
  // A symbol is a ticker, not a sentence. Anything else is the model guessing.
  const sym = typeof obj.symbol === 'string' ? obj.symbol.trim().toUpperCase() : '';
  return {
    intent,
    symbol: /^[A-Z0-9.\-]{1,12}$/.test(sym) ? sym : null,
  };
}

// Whatever the model wrapped its prose in, strip it back to prose.
function scrubAnswer(raw, limit = 1200) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .replace(/^\s*(answer|response)\s*:\s*/i, '')
    .replace(/[—―]/g, ', ')             // em dash and horizontal bar
    .replace(/·/g, ', ')                     // middot
    .replace(/[‐‑‒–]/g, '-')  // the hyphen family, flattened to ascii
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, limit);
}

// Words that identify nothing, so matching on them would attach the wrong asset
// to a question. "Group" appears in dozens of company names.
const NOISE = new Set([
  'inc', 'corp', 'corporation', 'ltd', 'limited', 'plc', 'co', 'group', 'holding',
  'holdings', 'the', 'and', 'trust', 'etf', 'fund', 'class', 'nv', 'sa', 'ag',
  'platforms', 'technologies', 'company', 'international', 'tokenised', 'tokenized',
]);

// Which asset a question is about, decided from the board rather than by the
// model. A ticker the model failed to spot, or a plain word like "gold" that is
// a name rather than a symbol, both resolve here. Deterministic on purpose,
// because fetching the wrong asset is how a confident wrong answer gets made.
function resolveAsset(question, board, modelSymbol) {
  if (!Array.isArray(board) || !board.length) return null;
  const q = ' ' + String(question || '').toLowerCase().replace(/[^a-z0-9. ]+/g, ' ') + ' ';
  const has = (w) => q.includes(' ' + String(w).toLowerCase() + ' ');

  if (modelSymbol) {
    const hit = board.find((a) => (a.symbol || '').toUpperCase() === modelSymbol);
    if (hit) return hit;
  }
  // An exact ticker in the text beats everything.
  for (const a of board) {
    if (a.symbol && a.symbol.length >= 2 && has(a.symbol)) return a;
  }
  // Otherwise the most specific name word that identifies exactly one asset.
  let best = null;
  const wordsOf = (n) => String(n || '').toLowerCase().split(/[^a-z0-9]+/);
  for (const a of board) {
    for (const w of wordsOf(a.name)) {
      if (w.length < 3 || NOISE.has(w) || !has(w)) continue;
      if (board.filter((b) => wordsOf(b.name).includes(w)).length !== 1) continue;
      if (!best || w.length > best.w.length) best = { a, w };
    }
  }
  return best ? best.a : null;
}

const CLASSIFY_SYSTEM = `You route a question to one data source for a CoinMarketCap
dashboard. Reply with JSON only, no prose, in the form {"intent":"...","symbol":"..."}.

intent must be exactly one of:
  quote      the live price, change or market cap of a named crypto asset
  spreads    which tokenised assets are priced most differently across venues
  asset      one named real world asset, its wrappers and its issuers
  regime     what the crypto market as a whole is doing, breadth, sentiment, sectors
  issuers    who mints tokenised assets and what each has minted
  capability what this API key and plan can actually reach
  unknown    the question is about none of these

symbol is the ticker the question names, uppercase, or null if it names none. Resolve a
common name to its ticker: near is NEAR, bitcoin is BTC, ether is ETH, solana is SOL.`;

const ANSWER_SYSTEM = `You are the analyst voice of Signal Desk, a dashboard built on the
CoinMarketCap API.

The DATA block below is the only source of numbers you have. Obey these rules exactly:
- Never state a number that is not in the DATA block. Never estimate, round up to a
  rounder figure, or infer a value that is not there.
- If the DATA does not answer the question, say so plainly in one sentence and say what
  it does show instead. That is a good answer, not a failure.
- A wrapper with no volume, or flagged thin, is a published price and not a tradable one.
  Never call it cheap.
- weightedSpreadBps is the honest measure of how dislocated an asset is. tradableSpreadBps
  is the outright gap. When the second is much larger, the gap sits on a venue almost
  nobody trades, and you must say so.
- history being null means not enough readings yet, which is not the same as normal.

Answer the question that was asked. Do not recite the data block field by field, and do
not mention field names: a reader wants "two thirds of the volume sits at one venue", not
"topVenueShare is 0.66". Express a share as a percentage. Lead with the answer, then give
the one or two numbers that support it, then any caveat that changes what it means.

Write two to four sentences of plain prose. No lists, no headings, no markdown, no emoji.
No em dashes. Name the issuers and venues involved. Be specific and unhurried.`;

// A compact, machine-readable statement of what was actually fetched. The model
// sees this and nothing else, so anything absent here cannot appear in the answer.
function buildAnswerPrompt(question, facts) {
  return `QUESTION: ${String(question).slice(0, 500)}

DATA:
${JSON.stringify(facts, null, 1).slice(0, 12000)}`;
}

// A model repeats the precision it is handed, so 377.7543906992903 basis points
// comes straight back at the reader. Rounding happens before the payload is
// built, by field name, because a price and a basis point measurement do not
// deserve the same number of places.
const PLACES = {
  bps: 1, share: 3, pct: 2, price: 4, vwap: 4, volume: 0, default: 4,
};
function tidy(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => tidy(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = tidy(v, k);
    return out;
  }
  if (typeof value !== 'number' || !isFinite(value)) return value;
  const k = key.toLowerCase();
  const places = /bps/.test(k) ? PLACES.bps
    : /share|concentration|percentile/.test(k) ? PLACES.share
    : /pct|percent|change/.test(k) ? PLACES.pct
    : /volume|cap|marketcap/.test(k) ? PLACES.volume
    : /price|vwap|median|max|min/.test(k) ? PLACES.price
    : PLACES.default;
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/* --------------------------- the model client --------------------------- */

// Two wire shapes, because the inference that happens to be available is not
// always the inference the code was written against. An OpenAI compatible
// endpoint and a local Ollama differ in the path, the auth and where the reply
// sits, and in nothing else that matters here.
//
// The shape is stated by BRAIN_KIND when it needs to be, and otherwise inferred:
// a key, or a base ending in /v1, means OpenAI compatible.
function wireShape({ base, key, kind }) {
  if (kind === 'openai' || kind === 'ollama') return kind;
  if (key) return 'openai';
  return /\/v1\/?$/.test(String(base || '')) ? 'openai' : 'ollama';
}

function buildRequest({ base, model, key, kind, system, user, temperature = 0.2 }) {
  const shape = wireShape({ base, key, kind });
  const root = String(base || '').replace(/\/$/, '');
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  return shape === 'openai'
    ? { shape, url: `${root}/chat/completions`, headers, body: { model, messages, temperature } }
    : { shape, url: `${root}/api/chat`, headers, body: { model, messages, stream: false, options: { temperature } } };
}

// Where the text lives, and what to say when there is none. An OpenAI style
// error body carries a message worth surfacing rather than discarding.
function readReply(shape, j) {
  if (j && j.error) {
    const m = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error));
    return { ok: false, msg: String(m).slice(0, 200) };
  }
  const content = shape === 'openai'
    ? (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content)
    : (j && j.message && j.message.content);
  if (typeof content !== 'string' || !content.trim()) return { ok: false, msg: 'model returned nothing' };
  return { ok: true, content };
}

async function chat(opts) {
  const { timeoutMs = 25000 } = opts;
  const req = buildRequest(opts);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: 'POST', headers: req.headers, signal: ctl.signal, body: JSON.stringify(req.body),
    });
    let j = null;
    try { j = await res.json(); } catch { /* handled below */ }
    if (!res.ok) {
      const r = readReply(req.shape, j);
      return { ok: false, msg: r.msg && r.msg !== 'model returned nothing' ? r.msg : `model http ${res.status}` };
    }
    return readReply(req.shape, j);
  } catch (e) {
    return { ok: false, msg: e.name === 'AbortError' ? 'model timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ rate limit ------------------------------ */

// A public box in front of a model needs a ceiling. Per caller, fixed window,
// in memory, because one process and one box is the honest scale of this app.
class RateLimiter {
  constructor(max = 8, windowMs = 60000) {
    this.max = max; this.windowMs = windowMs; this.hits = new Map();
  }
  take(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const seen = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (seen.length >= this.max) {
      this.hits.set(key, seen);
      return { ok: false, retryInSec: Math.ceil((seen[0] + this.windowMs - now) / 1000) };
    }
    seen.push(now);
    this.hits.set(key, seen);
    // Opportunistic sweep, so an idle key does not sit in the map for ever.
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (!v.some((t) => t > cutoff)) this.hits.delete(k);
    }
    return { ok: true, remaining: this.max - seen.length };
  }
}

module.exports = {
  INTENTS, UNITS, keywordIntent, parseIntent, scrubAnswer, resolveAsset, tidy, buildAnswerPrompt,
  CLASSIFY_SYSTEM, ANSWER_SYSTEM, chat, wireShape, buildRequest, readReply, RateLimiter,
};
