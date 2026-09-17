// The routing, the parsing and the ceiling are pure, so they are tested without
// a model behind them. What the model writes is not testable here; what it is
// allowed to be given, and what happens when it answers badly, is.
const b = require('../lib/brain.js');
let fail = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL ' + m); fail++; } else console.log('  ok   ' + m); };

console.log('the keyword router covers each intent without a model:');
ok(b.keywordIntent('which asset has the widest spread') === 'spreads', 'spread wording routes to spreads');
ok(b.keywordIntent('what is current near price') === 'quote',         'asking a price routes to quote');
ok(b.keywordIntent('how much is bitcoin') === 'quote',                'and so does asking how much');
ok(b.keywordIntent('market cap of solana') === 'quote',               'and asking a market cap');
// A stem with a trailing word boundary can never match its own inflections,
// which silently broke the fallback for the commonest word on the board.
ok(b.keywordIntent('which is most dislocated') === 'spreads',         'an inflected stem still routes');
ok(b.keywordIntent('show me the dislocation') === 'spreads',          'and so does the noun form');
ok(b.keywordIntent('is tokenised gold cheap') === 'asset',            'tokenised routes to an asset');
ok(b.keywordIntent('where is tokenised gold cheapest') === 'spreads', 'unless it asks about venues');
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
ok(t.volume24h === '$1.23M',             'volume becomes a readable amount, not thirteen digits');
ok(b.money(2610613494899) === '$2.61T',   'trillions read as trillions');
ok(b.money(857947658) === '$857.95M',     'and millions as millions');
ok(b.money(4321) === '$4.3K',             'and thousands as thousands');
ok(b.money(83.5) === '$83.50',            'small amounts keep cents');
ok(b.money(-1500) === '-$1.5K',           'a negative keeps its sign');
ok(b.money(null) === null,                'a null is not formatted into nonsense');
ok(t.topVenueShare === 0.641,            'a share keeps three');
ok(t.premiumPct === -0.42,               'a percentage keeps two');
ok(t.symbol === 'GOLD',                  'a string is untouched');
ok(t.nothing === null,                   'a null is untouched');
ok(t.flag === true,                      'a boolean is untouched');
ok(t.nested[0].tradableSpreadBps === 12.3, 'rounding reaches inside arrays');
ok(t.nested[0].price === 1.2346,          'and inside nested objects');
ok(b.tidy(Infinity) === Infinity,         'a non finite number is left alone rather than mangled');
ok(b.tidy('x') === 'x',                   'a bare string survives');


console.log('the wire shape is inferred, or stated when it must be:');
ok(b.wireShape({ base: 'https://api.x.ai/v1', key: 'k' }) === 'openai', 'a key means openai compatible');
ok(b.wireShape({ base: 'https://api.x.ai/v1' }) === 'openai',           'so does a base ending in v1');
ok(b.wireShape({ base: 'https://api.x.ai/v1/' }) === 'openai',          'even with a trailing slash');
ok(b.wireShape({ base: 'http://127.0.0.1:11434' }) === 'ollama',        'a bare host is ollama');
ok(b.wireShape({ base: 'https://api.x.ai/v1', kind: 'ollama' }) === 'ollama', 'an explicit kind overrides both');
ok(b.wireShape({ base: '' }) === 'ollama',                              'and an empty base does not throw');

console.log('each shape builds the request its server expects:');
const oa = b.buildRequest({ base: 'https://api.s.ai/v1', key: 'secret', model: 'gpt-5.4', system: 'S', user: 'U' });
ok(oa.url === 'https://api.s.ai/v1/chat/completions',  'openai posts to chat/completions');
ok(oa.headers.authorization === 'Bearer secret',       'and carries bearer auth');
ok(oa.body.messages.length === 2,                      'with system and user messages');
ok(oa.body.stream === undefined,                       'and no ollama only fields');
const ol = b.buildRequest({ base: 'http://127.0.0.1:11434', model: 'm', system: 'S', user: 'U' });
ok(ol.url === 'http://127.0.0.1:11434/api/chat',       'ollama posts to api/chat');
ok(ol.body.stream === false,                           'with streaming off');
ok(ol.headers.authorization === undefined,             'and no auth header when there is no key');
ok(b.buildRequest({ base: 'https://a/v1/', key: 'k', model: 'm' }).url === 'https://a/v1/chat/completions',
                                                       'a trailing slash does not double up');

console.log('the reply is read from wherever that shape puts it:');
ok(b.readReply('openai', { choices: [{ message: { content: 'hi' } }] }).content === 'hi', 'openai reply parses');
ok(b.readReply('ollama', { message: { content: 'hi' } }).content === 'hi',                'ollama reply parses');
ok(b.readReply('openai', { error: { message: 'no credit' } }).msg === 'no credit',        'an error object is surfaced');
ok(b.readReply('openai', { error: 'plain string' }).msg === 'plain string',               'and so is an error string');
ok(b.readReply('openai', { choices: [] }).ok === false,                                   'no choices is a failure');
ok(b.readReply('openai', { choices: [{ message: { content: '   ' } }] }).ok === false,     'whitespace is not an answer');
ok(b.readReply('ollama', null).ok === false,                                              'a null body is a failure');
ok(b.readReply('openai', {}).msg === 'model returned nothing',                            'and says so plainly');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
