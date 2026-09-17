// Regression test for the wrapper spread. Pure arithmetic over a quotes payload,
// so no network and no key. The fixture is the live CRCL response, which is the
// case the numbers were first checked by hand against.
const { wrapperSpread, LIQUID_MIN } = require('../lib/spread.js');
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
ok(near(s.rows[0].bpsFromBaseline, 0),          'the baseline row is zero from itself');
ok(near(s.rows[1].bpsFromBaseline, 16.6, 0.2),  'Ondo sits 17 bps over the baseline');
ok(s.baseline.issuer === 'Reality',             'the baseline is the cheapest wrapper that trades');
ok(s.rows[0].isBaseline === true,               'and it is flagged as such');
ok(s.offScale.length === 0,                     'nothing in CRCL is off the reference scale');

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
const half = wrapperSpread([{ symbol: 'A', price: 82.0, volume24h: 5 }, { symbol: 'B', price: null }], REF);
ok(half !== null && half.count === 1,           'the priced wrapper survives');
ok(half.unpriced === 1,                         'the dropped one is reported, not hidden');
ok(half.spreadBps === 0,                        'one wrapper has no spread against itself');
ok(half.rows[0].isBaseline === true,             'the lone wrapper is its own baseline');
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


console.log('a wrapper quoting a different unit cannot be ranked against the rest:');
// Gold is the live case: VNXAU and CGO are one gram, the rest one troy ounce,
// a factor of 31.1. Ranking them together reported 305274 bps before this.
const GOLD = [
  { symbol: 'VNXAU', issuer: 'VNX',              price: 137.31,  volume24h: 22438 },
  { symbol: 'CGO',   issuer: 'Comtech Gold',     price: 138.91,  volume24h: 870051 },
  { symbol: 'XAUM',  issuer: 'Matrixdock',       price: 4307.87, volume24h: 633962 },
  { symbol: 'XAUT0', issuer: 'Tether Holdings',  price: 4313.39, volume24h: 1049041 },
  { symbol: 'XAUt',  issuer: 'Tether Holdings',  price: 4320.31, volume24h: 371919567 },
  { symbol: 'PAXG',  issuer: 'Paxos',            price: 4322.75, volume24h: 277118121 },
  { symbol: 'XAU',   issuer: 'NA (Derivatives)', price: 4328.96, volume24h: 0 },
];
const g = wrapperSpread(GOLD, 4320.659380151614);
ok(g.count === 5,                               'only the ounce denominated wrappers are ranked');
ok(g.offScale.length === 2,                     'both gram denominated tokens are set aside');
ok(g.offScale.every((t) => t.ratioToAnchor < 0.05), 'and each is reported as a fraction of the anchor');
ok(g.spreadBps < 100,                           'the spread is now double digits, not six');
ok(near(g.spreadBps, 48.9, 0.5),                'and reads 49 bps');
ok(g.rows.every((r) => r.price > 1000),         'no gram price survives into the ranking');
ok(g.offScale.some((t) => t.symbol === 'VNXAU'), 'the excluded wrapper is still named, not dropped');

console.log('the anchor falls back to the median when no reference is given:');
const noRefGold = wrapperSpread(GOLD);
ok(noRefGold.count === 5,                       'the median follows the majority denomination');
ok(noRefGold.offScale.length === 2,             'and the minority is still set aside');

console.log('an anchor that agrees with nothing yields no ranking at all:');
const lonely = wrapperSpread([{ symbol: 'A', price: 100, volume24h: 5 }], 1);
ok(lonely === null,                             'a reference far from every wrapper refuses to rank');

console.log('a stale quote is not a cheap one:');
// The live META case: a zero volume venue sits ~1200 bps under the cluster.
const META = [
  { symbol: 'META',   issuer: 'Hyperliquid Assets', price: 600.59549229, volume24h: 0 },
  { symbol: 'rMETA',  issuer: 'Reality',            price: 681.24470077, volume24h: 192703 },
  { symbol: 'METAB',  issuer: 'bStocks',            price: 681.63225043, volume24h: 3293029 },
  { symbol: 'METAon', issuer: 'Ondo Assets',        price: 683.30482701, volume24h: 5594547 },
];
const m = wrapperSpread(META, 682.0);
ok(m.baseline.issuer === 'Reality',             'the baseline skips the venue with no volume');
ok(m.rows[0].bpsFromBaseline < -1000,           'the stale quote reads as far BELOW the baseline');
ok(m.rows[0].liquid === false,                  'and is flagged as untradable beside that number');
ok(m.rows[0].isBaseline === false,              'so it never becomes the thing others are measured against');
ok(near(m.tradableSpreadBps, 30.2, 0.5),        'the tradable spread ignores it entirely');
ok(m.spreadBps > 1000,                          'while the all wrappers figure still reports it honestly');


console.log('a venue with nine dollars of volume is not a venue:');
// The live GOOGL case. Two wrappers quoting hundreds of bps away from the rest
// carried 43 and 9 dollars of 24h volume, and being merely nonzero was enough
// to put them at both ends of the dislocation ranking.
const GOOGL = [
  { symbol: 'GOOGL',   issuer: 'Hyperliquid Assets', price: 334.8027, volume24h: 43 },
  { symbol: 'GOOGon',  issuer: 'Ondo Assets',        price: 342.6236, volume24h: 9 },
  { symbol: 'GOOGLB',  issuer: 'bStocks',            price: 345.7712, volume24h: 43052242 },
  { symbol: 'GOOGL',   issuer: 'Robinhood',          price: 346.0686, volume24h: 24735464 },
  { symbol: 'GOOGL',   issuer: 'NA (Derivatives)',   price: 346.6815, volume24h: 0 },
  { symbol: 'GOOGLon', issuer: 'Ondo Assets',        price: 347.3430, volume24h: 16189506 },
];
const gg = wrapperSpread(GOOGL, 346.0);
ok(gg.count === 6,                              'every wrapper is still ranked and shown');
ok(gg.tradableCount === 3,                      'only the three with real volume count as tradable');
ok(gg.tradableCheapest.issuer === 'bStocks',    'the baseline skips the 43 dollar venue');
ok(near(gg.tradableSpreadBps, 45.4, 1),         'the tradable spread is 45 bps, not 375');
ok(gg.spreadBps > 300,                          'the all wrappers figure still reports the full range');
ok(gg.rows.find((r) => r.issuer === 'Ondo Assets' && r.volume24h === 9).thin === true,
                                                'the 9 dollar wrapper is marked thin, not dead');
ok(gg.rows.find((r) => r.volume24h === 0).thin === false,
                                                'and a wrapper with no volume is dead, not thin');
ok(gg.rows.find((r) => r.volume24h === 0).liquid === false, 'neither counts as liquid');
ok(gg.baseline.issuer === 'bStocks',            'so the baseline is a price someone actually paid');

console.log('the liquidity floor is a stated number, not a magic one:');
ok(typeof LIQUID_MIN === 'number' && LIQUID_MIN > 0, 'the floor is exported so callers can cite it');
const atFloor = wrapperSpread([
  { symbol: 'A', price: 100, volume24h: LIQUID_MIN },
  { symbol: 'B', price: 101, volume24h: LIQUID_MIN - 1 },
], 100);
ok(atFloor.rows[0].liquid === true,             'a wrapper exactly at the floor is liquid');
ok(atFloor.rows[1].liquid === false,            'one dollar under it is not');
ok(atFloor.tradableSpreadBps === null,          'and one liquid venue alone yields no tradable spread');

console.log('the input is never mutated:');
const before = JSON.stringify(CRCL);
wrapperSpread(CRCL, REF);
ok(JSON.stringify(CRCL) === before,             'the caller keeps the payload it passed in');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
