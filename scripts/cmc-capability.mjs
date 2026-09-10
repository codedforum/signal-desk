// What can this CMC key actually do?
//
// Written because the plan for both the Corvo fallback and the hackathon build
// depends entirely on tier, and the tier is not visible from the dashboard in a
// way that maps onto endpoints. Guessing produced three wrong answers in a row:
// 405 was the wrong HTTP method, 400 was the wrong body, and 403 was the real
// limit. This asks the live API instead of a document.
//
// Run it again the moment the plan changes and diff the output. A capability
// list written by hand rots; this one cannot.
//
//   node cmc-capability.mjs           human readable
//   node cmc-capability.mjs --json    machine readable, for diffing
import 'dotenv/config';

const KEY = process.env.CMC_API_KEY;
if (!KEY) { console.error('CMC_API_KEY not set'); process.exit(1); }

const BASE = 'https://pro-api.coinmarketcap.com';
const HEAD = { 'X-CMC_PRO_API_KEY': KEY, accept: 'application/json' };
const JSON_HEAD = { ...HEAD, 'Content-Type': 'application/json' };
const jsonOut = process.argv.includes('--json');

// method matters: several DEX endpoints answer 405 to a GET and work as POST.
const PROBES = [
  ['standard', 'listings latest',        'GET',  '/v1/cryptocurrency/listings/latest?limit=1'],
  ['standard', 'global metrics',         'GET',  '/v1/global-metrics/quotes/latest'],
  ['standard', 'categories',             'GET',  '/v1/cryptocurrency/categories?limit=1'],
  ['standard', 'fear and greed',         'GET',  '/v3/fear-and-greed/latest'],
  ['standard', 'map',                    'GET',  '/v1/cryptocurrency/map?limit=1'],
  ['standard', 'quotes latest',          'GET',  '/v1/cryptocurrency/quotes/latest?symbol=BTC'],
  ['gated',    'listings new',           'GET',  '/v1/cryptocurrency/listings/new?limit=1'],
  ['gated',    'trending latest',        'GET',  '/v1/cryptocurrency/trending/latest?limit=1'],
  ['gated',    'trending most visited',  'GET',  '/v1/cryptocurrency/trending/most-visited?limit=1'],
  ['gated',    'gainers losers',         'GET',  '/v1/cryptocurrency/trending/gainers-losers?limit=1'],
  ['community','community trending tok', 'GET',  '/v1/community/trending/token'],
  ['community','community trending top', 'GET',  '/v1/community/trending/topic'],
  ['community','content latest',         'GET',  '/v1/content/latest?limit=1'],
  ['dex',      'platform list',          'GET',  '/v1/dex/platform/list?limit=5'],
  ['dex',      'dex gainers',            'POST', '/v1/dex/gainer-loser/list', { type: 'gainer', time_period: '24h', limit: 1 }],
  ['dex',      'dex new tokens',         'POST', '/v1/dex/new/list',          { time_period: '24h', limit: 1 }],
  ['dex',      'dex meme list',          'POST', '/v1/dex/meme/list',         { network_slug: 'base', limit: 1 }],
  ['rwa',      'rwa map',                'GET',  '/v1/rwa/map'],
  ['rwa',      'rwa listings',           'GET',  '/v1/rwa/listings/latest'],
];

// The five chains Corvo routes on. Coverage here is what decides whether CMC can
// stand in for GeckoTerminal, or only rescue the majors.
const CHAINS = ['base', 'solana', 'fogo', 'robinhood', 'x layer'];

const probe = async ([group, label, method, path, body]) => {
  const started = Date.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: method === 'POST' ? JSON_HEAD : HEAD,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => ({}));
    const msg = j?.status?.error_message || '';
    // 403 is the plan gate. 405 and 400 are our mistake, not a limit, so they are
    // reported differently: they mean the probe is wrong, not the key.
    const verdict = res.status === 200 ? 'yes'
      : res.status === 403 ? 'plan'
      : res.status === 405 ? 'wrong-method'
      : res.status === 400 ? 'wrong-params'
      : String(res.status);
    return { group, label, method, path, status: res.status, verdict, msg: msg.slice(0, 70), ms: Date.now() - started };
  } catch (e) {
    return { group, label, method, path, status: 0, verdict: 'error', msg: String(e.message).slice(0, 70), ms: Date.now() - started };
  }
};

const chainCoverage = async () => {
  try {
    const res = await fetch(BASE + '/v1/dex/platform/list?limit=500', { headers: HEAD, signal: AbortSignal.timeout(20000) });
    if (res.status !== 200) return { available: false, status: res.status };
    const j = await res.json();
    const rows = j.data || [];
    // Field names are abbreviated (n, dn, id), so match the whole row rather than
    // a guessed key. Assuming `name` returned zero hits for chains that are there.
    const found = {};
    for (const want of CHAINS) {
      const hit = rows.find(r => JSON.stringify(r).toLowerCase().includes(want));
      found[want] = hit ? { id: hit.id, name: hit.n || hit.dn } : null;
    }
    return { available: true, total: rows.length, found };
  } catch (e) { return { available: false, error: String(e.message).slice(0, 60) }; }
};

const results = [];
for (const p of PROBES) results.push(await probe(p));
const chains = await chainCoverage();

if (jsonOut) {
  console.log(JSON.stringify({ at: new Date().toISOString(), results, chains }, null, 2));
} else {
  const byGroup = {};
  for (const r of results) (byGroup[r.group] ||= []).push(r);
  console.log('CMC key capability, ' + new Date().toISOString());
  console.log('='.repeat(72));
  for (const [g, rs] of Object.entries(byGroup)) {
    console.log('\n[' + g + ']');
    for (const r of rs) {
      const mark = r.verdict === 'yes' ? '  OK  ' : r.verdict === 'plan' ? ' PLAN ' : '  ??  ';
      console.log(mark + r.label.padEnd(24) + String(r.status).padEnd(5) + r.verdict.padEnd(14) + r.msg);
    }
  }
  const usable = results.filter(r => r.verdict === 'yes').length;
  console.log('\n' + '='.repeat(72));
  console.log(`usable now: ${usable} of ${results.length}   plan-gated: ${results.filter(r => r.verdict === 'plan').length}`);
  console.log('\nchain coverage (decides if CMC can replace GeckoTerminal for Corvo):');
  if (!chains.available) console.log('  platform list unavailable:', chains.status || chains.error);
  else {
    console.log(`  ${chains.total} networks known to CMC`);
    for (const [k, v] of Object.entries(chains.found)) {
      console.log('   ' + k.padEnd(11) + (v ? `covered, platform id ${v.id} (${v.name})` : 'NOT COVERED'));
    }
  }
}
