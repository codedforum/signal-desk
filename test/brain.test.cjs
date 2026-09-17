// The routing, the parsing and the ceiling are pure, so they are tested without
// a model behind them. What the model writes is not testable here; what it is
// allowed to be given, and what happens when it answers badly, is.
const b = require('../lib/brain.js');
let fail = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL ' + m); fail++; } else console.log('  ok   ' + m); };

console.log('the keyword router covers each intent without a model:');
ok(b.keywordIntent('which asset has the widest spread') === 'spreads', 'spread wording routes to spreads');
ok(b.keywordIntent('where is tokenised NVDA cheapest') === 'spreads', 'so does cheapest');
ok(b.keywordIntent('what is the market doing') === 'regime',          'market wording routes to regime');
ok(b.keywordIntent('how is breadth looking') === 'regime',            'so does breadth');
ok(b.keywordIntent('who issues tokenised gold') === 'issuers',        'issuer wording routes to issuers');
ok(b.keywordIntent('what can the free plan reach') === 'capability',  'plan wording routes to capability');
ok(b.keywordIntent('tell me about tokenised silver') === 'asset',     'a tokenised thing routes to asset');
ok(b.keywordIntent('what is the weather') === 'unknown',              'an unrelated question routes to unknown');
ok(b.keywordIntent('') === 'unknown',                                 'an empty question routes to unknown');
ok(b.keywordIntent(null) === 'unknown',                               'so does no question at all');

console.log('the model\'s JSON is parsed defensively:');
ok(b.parseIntent('{"intent":"spreads","symbol":"NVDA"}').intent === 'spreads', 'clean json parses');
ok(b.parseIntent('{"intent":"spreads","symbol":"nvda"}').symbol === 'NVDA',    'a lowercase ticker is normalised');
ok(b.parseIntent('```json\n{"intent":"regime","symbol":null}\n```').intent === 'regime', 'a fenced block parses');
ok(b.parseIntent('Sure! {"intent":"asset","symbol":"GOLD"} hope that helps').intent === 'asset',
                                                                              'json buried in prose parses');
ok(b.parseIntent('{"intent":"asset","symbol":null}').symbol === null,         'a null symbol stays null');
ok(b.parseIntent('{"intent":"asset","symbol":"the gold one"}').symbol === null,
                                                                              'a sentence is not a ticker');
ok(b.parseIntent('{"intent":"asset","symbol":"ABCDEFGHIJKLMNOP"}').symbol === null,
                                                                              'an over long ticker is refused');
ok(b.parseIntent('{"intent":"teleport"}') === null,      'an invented intent is refused outright');
ok(b.parseIntent('not json at all') === null,            'prose with no json is refused');
ok(b.parseIntent('{"broken":') === null,                 'malformed json is refused');
ok(b.parseIntent('') === null,                           'an empty string is refused');
ok(b.parseIntent(null) === null,                         'so is a null');
ok(b.parseIntent(42) === null,                           'and a number');

console.log('house style is enforced on the way out, not requested politely:');
ok(!b.scrubAnswer('gold is wide — very wide').includes('—'), 'an em dash is removed');
ok(!b.scrubAnswer('a · b').includes('·'),                    'so is a middot');
ok(b.scrubAnswer('```\nhello\n```') === 'hello',                       'a code fence is stripped');
ok(b.scrubAnswer('```json\nhello\n```') === 'hello',                   'a tagged fence too');
ok(b.scrubAnswer('Answer: the spread is wide') === 'the spread is wide', 'a label prefix is stripped');
ok(b.scrubAnswer('  padded  ') === 'padded',                           'whitespace is trimmed');
ok(b.scrubAnswer('x'.repeat(5000)).length === 1200,                    'a runaway answer is capped');
ok(b.scrubAnswer(null) === '',                                         'a missing answer becomes empty');

console.log('the model only ever sees what was actually fetched:');
const prompt = b.buildAnswerPrompt('is gold wide', { symbol: 'GOLD', weightedSpreadBps: 6.2 });
ok(prompt.includes('is gold wide'),        'the question is carried');
ok(prompt.includes('6.2'),                 'and the fetched number');
ok(prompt.includes('DATA:'),               'under a labelled data block');
const huge = b.buildAnswerPrompt('q', { big: 'y'.repeat(50000) });
ok(huge.length < 13000,                    'an oversized payload is truncated before it reaches the model');
const longQ = b.buildAnswerPrompt('z'.repeat(5000), {});
ok(longQ.indexOf('DATA:') < 600,           'and so is an oversized question');

console.log('the public box has a ceiling:');
const rl = new b.RateLimiter(3, 60000);
const T = 1000000;
ok(rl.take('a', T).ok,                     'first call allowed');
ok(rl.take('a', T).ok,                     'second allowed');
ok(rl.take('a', T).ok,                     'third allowed');
const denied = rl.take('a', T);
ok(!denied.ok,                             'fourth refused');
ok(denied.retryInSec > 0 && denied.retryInSec <= 60, 'and says when to come back');
ok(rl.take('b', T).ok,                     'a different caller is unaffected');
ok(rl.take('a', T + 60001).ok,             'the window rolls off');
ok(rl.take('c', T).remaining === 2,        'a fresh caller is told how many it has left');
ok(rl.take('c', T).remaining === 1,        'and the count falls with each call');


console.log('which asset a question names is decided from the board, not by the model:');
const BOARD = [
  { id: 1, symbol: 'GOLD',  name: 'Gold' },
  { id: 2, symbol: 'TSM',   name: 'Taiwan Semiconductor Manufacturing Co Ltd' },
  { id: 3, symbol: 'META',  name: 'Meta Platforms, Inc.' },
  { id: 4, symbol: 'GOOGL', name: 'Alphabet Inc Class A' },
  { id: 5, symbol: 'SLV',   name: 'iShares Silver Trust' },
  { id: 6, symbol: 'SPY',   name: 'SPDR S&P 500 ETF Trust' },
];
const sym = (q, s) => { const r = b.resolveAsset(q, BOARD, s); return r ? r.symbol : null; };
ok(sym('where is tokenised gold cheapest') === 'GOLD',   'a plain name the model missed still resolves');
ok(sym('how wide is TSM right now') === 'TSM',           'a ticker in the text resolves');
ok(sym('tell me about taiwan semiconductor') === 'TSM',  'a company name resolves');
ok(sym('is silver dislocated') === 'SLV',                'so does a distinctive name word');
ok(sym('what about alphabet') === 'GOOGL',               'and one that is not the ticker at all');
ok(sym('which is most dislocated right now') === null,   'a general question names no asset');
ok(sym('what is the market doing') === null,             'nor does a market question');
ok(sym('anything on NVDA', 'NVDA') === null,             'a symbol not on the board resolves to nothing');
ok(sym('how wide is meta', 'GOLD') === 'GOLD',           'the model\'s symbol is trusted when it is on the board');
ok(sym('tell me about the trust') === null,              'a word shared by several names matches none of them');
ok(sym('anything', []) === null,                         'an empty board resolves nothing');
ok(sym('anything', null) === null,                       'and neither does a missing one');


console.log('precision is cut before the model sees it, not after:');
const t = b.tidy({
  weightedSpreadBps: 377.7543906992903,
  price: 4305.783580671026,
  vwap: 4321.185912345678,
  volume24h: 1234567.891234,
  topVenueShare: 0.6412345678,
  premiumPct: -0.4225116,
  symbol: 'GOLD',
  nested: [{ tradableSpreadBps: 12.3456789, price: 1.23456789 }],
  nothing: null,
  flag: true,
});
ok(t.weightedSpreadBps === 377.8,        'basis points land on one decimal');
ok(t.price === 4305.7836,                'a price keeps four');
ok(t.vwap === 4321.1859,                 'and so does a volume weighted price');
ok(t.volume24h === 1234568,              'volume is a whole number');
ok(t.topVenueShare === 0.641,            'a share keeps three');
ok(t.premiumPct === -0.42,               'a percentage keeps two');
ok(t.symbol === 'GOLD',                  'a string is untouched');
ok(t.nothing === null,                   'a null is untouched');
ok(t.flag === true,                      'a boolean is untouched');
ok(t.nested[0].tradableSpreadBps === 12.3, 'rounding reaches inside arrays');
ok(t.nested[0].price === 1.2346,          'and inside nested objects');
ok(b.tidy(Infinity) === Infinity,         'a non finite number is left alone rather than mangled');
ok(b.tidy('x') === 'x',                   'a bare string survives');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
