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

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
