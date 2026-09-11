// Regression test for the capability probe. No network and no key: probeQuery
// is pure given the resolved ids, so the exact failures seen in the CMC
// dashboard can be asserted directly.
const cmc = require('../lib/cmc.js');
let fail = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL ' + m); fail++; } else console.log('  ok   ' + m); };

const ids = { categoryId: 'abc123', rwaId: 2, issuerId: 'iss789' };

console.log('endpoints that the dashboard showed answering 400 or 4002:');
ok(cmc.probeQuery('quotes', ids)    === 'symbol=BTC',        'quotes probes with a symbol');
ok(cmc.probeQuery('info', ids)      === 'symbol=BTC',        'info probes with a symbol');
ok(cmc.probeQuery('category', ids)  === 'id=abc123',         'category probes with an id');
ok(cmc.probeQuery('rwaInfo', ids)   === 'rwa_id=2',          'rwaInfo probes with rwa_id');
ok(cmc.probeQuery('rwaQuotes', ids) === 'rwa_id=2',          'rwaQuotes probes with rwa_id');
ok(cmc.probeQuery('rwaIssuer', ids) === 'issuer_id=iss789',  'rwaIssuer probes with issuer_id');

console.log('endpoints that were already fine keep the plain probe:');
for (const n of ['listings','global','categories','feargreed','platforms','rwaMap','rwaList','rwaIssuers','rwaPairs','trending','movers','fresh'])
  ok(cmc.probeQuery(n, ids) === 'limit=1', n + ' still probes with limit=1');

console.log('an unresolved id must skip, never masquerade as a bad request:');
for (const n of ['category','rwaInfo','rwaQuotes','rwaIssuer'])
  ok(cmc.probeQuery(n, {}) === null, n + ' returns null when its id is missing');

console.log('every endpoint is covered:');
for (const n of Object.keys(cmc.ENDPOINTS)) {
  const q = cmc.probeQuery(n, ids);
  ok(q === null || (typeof q === 'string' && q.length > 0), n + ' yields a query or an explicit null');
}
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
