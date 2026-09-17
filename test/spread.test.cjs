// Regression test for the wrapper spread. Pure arithmetic over a quotes payload,
// so no network and no key. The fixture is the live CRCL response, which is the
// case the numbers were first checked by hand against.
const { wrapperSpread } = require('../lib/spread.js');
let fail = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL ' + m); fail++; } else console.log('  ok   ' + m); };
const near = (a, b, tol = 0.05) => typeof a === 'number' && Math.abs(a - b) < tol;

// Seven wrappers of Circle, one of which CoinMarketCap carries with no volume.
const CRCL = [
  { symbol: 'CRCLB',  issuer: 'bStocks',          price: 81.9165579931309,  marketCap: 99158421.63, volume24h: 87180112.35 },
  { symbol: 'CRCLon', issuer: 'Ondo Assets',      price: 81.83788098031431, marketCap: 98864740.60, volume24h: 13942147.58 },
  { symbol: 'CRCLX',  issuer: 'Backed Assets',    price: 81.88704582996434, marketCap: 71901178.66, volume24h: 33441338.78 },
  { symbol: 'rCRCL',  issuer: 'Reality',          price: 81.70223135817342, marketCap: 13692418.13, volume24h: 3458981.81 },
  { symbol: 'CRCL',   issuer: 'Robinhood',        price: 82.05318550047606, marketCap: 5346585.98,  volume24h: 2791124.02 },
  { symbol: 'CRCL',   issuer: 'NA (Derivatives)', price: 81.94466746968669, marketCap: 0,           volume24h: 0 },
  { symbol: 'wCRCLx', issuer: 'Backed Assets',    price: 81.97153873904259, marketCap: 0,           volume24h: 348200.42 },
];
const REF = 82.04878676900812;

console.log('the live CRCL payload:');
const s = wrapperSpread(CRCL, REF);
ok(s !== null,                                  'a payload with prices yields a table');
ok(s.count === 7,                               'every priced wrapper is counted');
ok(s.unpriced === 0,                            'nothing in this payload was dropped');
ok(s.rows[0].issuer === 'Reality',              'the cheapest wrapper sorts first');
ok(s.rows[6].issuer === 'Robinhood',            'the dearest wrapper sorts last');
ok(s.cheapest.issuer === 'Reality',             'cheapest names the right issuer');
ok(s.dearest.issuer === 'Robinhood',            'dearest names the right issuer');
ok(near(s.spreadBps, 43.0, 0.2),                'the full spread is 43 bps');
ok(near(s.rows[0].bpsFromCheapest, 0),          'the cheapest row is zero from itself');
ok(near(s.rows[1].bpsFromCheapest, 16.6, 0.2),  'Ondo sits 17 bps over the cheapest');

console.log('a published price is not a tradable one:');
ok(s.tradableCount === 6,                       'the zero volume wrapper leaves the tradable set');
ok(s.rows.some((r) => r.liquid === false),      'it stays in the table, flagged');
ok(s.tradableCheapest.issuer === 'Reality',     'the cheapest tradable venue is named');
ok(s.tradableDearest.issuer === 'Robinhood',    'so is the dearest');

console.log('the reference price is the benchmark, not a wrapper:');
ok(near(s.reference, REF, 1e-9),                'the reference is carried through');
ok(s.rows[0].premiumPct < 0,                    'the cheapest trades under the reference');
ok(near(s.rows[0].premiumPct, -0.4225, 0.01),   'and by the right amount');

console.log('inputs that would otherwise produce nonsense:');
ok(wrapperSpread([], REF) === null,             'an empty list yields nothing at all');
ok(wrapperSpread(null, REF) === null,           'so does a missing list');
ok(wrapperSpread(undefined) === null,           'so does no argument');
ok(wrapperSpread([{ symbol: 'X', price: 0 }], REF) === null,    'a zero price is not a price');
ok(wrapperSpread([{ symbol: 'X', price: null }], REF) === null, 'nor is a null one');
ok(wrapperSpread([{ symbol: 'X', price: -3 }], REF) === null,   'nor is a negative one');
ok(wrapperSpread([{ symbol: 'X' }], REF) === null,              'nor is a missing field');

console.log('a partly priced list keeps the half that is real:');
const half = wrapperSpread([{ symbol: 'A', price: 10, volume24h: 5 }, { symbol: 'B', price: null }], REF);
ok(half !== null && half.count === 1,           'the priced wrapper survives');
ok(half.unpriced === 1,                         'the dropped one is reported, not hidden');
ok(half.spreadBps === 0,                        'one wrapper has no spread against itself');
ok(half.tradableSpreadBps === null,             'and no tradable spread either');
ok(half.tradableDearest === null,               'with no second venue to name');

console.log('no reference price is a missing benchmark, not a zero one:');
const noref = wrapperSpread([{ symbol: 'A', price: 10, volume24h: 1 }, { symbol: 'B', price: 11, volume24h: 1 }]);
ok(noref.reference === null,                    'the reference reads as absent');
ok(noref.rows.every((r) => r.premiumPct === null), 'every premium is null rather than invented');
ok(near(noref.spreadBps, 1000, 0.5),            'the spread still computes without it');
ok(wrapperSpread([{ symbol: 'A', price: 10 }], 0).reference === null, 'a zero reference is refused');

console.log('identical wrappers are a real answer, not an error:');
const flat = wrapperSpread([{ symbol: 'A', price: 50, volume24h: 1 }, { symbol: 'B', price: 50, volume24h: 1 }], 50);
ok(flat.spreadBps === 0,                        'two equal prices spread by nothing');
ok(flat.rows.every((r) => r.premiumPct === 0),  'and sit exactly on the reference');

console.log('the input is never mutated:');
const before = JSON.stringify(CRCL);
wrapperSpread(CRCL, REF);
ok(JSON.stringify(CRCL) === before,             'the caller keeps the payload it passed in');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
