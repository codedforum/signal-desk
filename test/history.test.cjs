// The statistics are pure and the store is a file, so both are testable today
// even though the thing they describe takes a month to accumulate.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SpreadHistory, percentileOf, quantile, verdict, MIN_READINGS, DAY } = require('../lib/history.js');
let fail = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL ' + m); fail++; } else console.log('  ok   ' + m); };
const near = (a, b, tol = 1e-9) => typeof a === 'number' && Math.abs(a - b) < tol;

console.log('quantiles over a known series:');
const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
ok(near(quantile(ten, 0), 1),            'q0 is the minimum');
ok(near(quantile(ten, 1), 10),           'q1 is the maximum');
ok(near(quantile(ten, 0.5), 5.5),        'the median interpolates between the middle pair');
ok(near(quantile([5], 0.5), 5),          'a single reading is its own median');
ok(quantile([], 0.5) === null,           'an empty series has no median');

console.log('where a reading sits in its own past:');
ok(near(percentileOf(ten, 10.5), 1),     'above everything reads as the top');
ok(near(percentileOf(ten, 0.5), 0),      'below everything reads as the bottom');
ok(near(percentileOf(ten, 5.5), 0.5),    'the middle reads as the middle');
ok(near(percentileOf([4, 4, 4], 4), 0.5),'a flat series puts a matching value in the middle, not at either end');
ok(percentileOf([], 5) === null,         'no history yields no percentile');
ok(percentileOf(ten, null) === null,     'and neither does a missing value');

console.log('a verdict needs enough past to be worth stating:');
ok(verdict([1, 2, 3], 99) === null,      'three readings is not a history');
ok(verdict(null, 5) === null,            'nor is no array at all');
const many = Array.from({ length: 50 }, (_, i) => i + 1);
ok(verdict(many, 25).band === 'normal',           'mid range reads as normal');
ok(verdict(many, 50).band === 'widest on record', 'the top reads as a record');
ok(verdict(many, 48).band === 'unusually wide',   'near the top reads as unusually wide');
ok(verdict(many, 2).band === 'unusually tight',   'near the bottom reads as unusually tight');
ok(verdict(many, 25).readings === 50,             'the verdict says how much it is based on');
ok(verdict(many, 25).max === 50 && verdict(many, 25).min === 1, 'and carries the range it saw');
ok(verdict(Array(MIN_READINGS).fill(5), 5) !== null, 'exactly the minimum is enough');
ok(verdict(Array(MIN_READINGS - 1).fill(5), 5) === null, 'one short is not');

console.log('the store round trips:');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-hist-'));
const file = path.join(dir, 'nested', 'spread-history.jsonl');
const h = new SpreadHistory(file);
const T = 1758000000;
ok(h.read().length === 0,                'reading a file that does not exist yields nothing, not a throw');
ok(h.series(115).length === 0,           'and neither does asking for a series');

ok(h.append([{ id: 115, weightedSpreadBps: 28.55, tradableSpreadBps: 39.3, vwap: 83.12345678, concentration: 0.6412 }], T) === 1,
                                         'one asset is written');
ok(fs.existsSync(file),                  'the directory is created on demand');
ok(h.append([
  { id: 115, weightedSpreadBps: 30, tradableSpreadBps: 41, vwap: 83.2, concentration: 0.64 },
  { id: 1, weightedSpreadBps: 6.2, tradableSpreadBps: 52.7, vwap: 4321.1, concentration: 0.57 },
], T + 900) === 2,                       'and two on the next snapshot');
ok(h.read().length === 2,                'two snapshots on disk');

const s115 = h.series(115);
ok(s115.length === 2,                    'the series for one asset spans both snapshots');
ok(s115[0].t === T && s115[1].t === T + 900, 'ordered oldest first');
ok(near(s115[0].weighted, 28.6, 0.01),   'the weighted figure is rounded to a tenth of a bp');
ok(near(s115[0].vwap, 83.1235, 1e-4),    'and the price to four places, not fourteen');
ok(h.series(1).length === 1,             'an asset present in only one snapshot has one point');
ok(h.series(99999).length === 0,         'an asset never seen has none');
ok(h.series(115, T + 500).length === 1,  'a since filter drops older snapshots');

console.log('bad input never reaches the file:');
ok(h.append([]) === 0,                            'an empty board writes nothing');
ok(h.append([{ id: 5 }]) === 0,                   'a row with no spread is skipped');
ok(h.append([{ weightedSpreadBps: 5 }]) === 0,    'so is a row with no id');
ok(h.append([{ id: 5, weightedSpreadBps: null }]) === 0, 'and one with a null spread');
ok(h.read().length === 2,                         'so the file still holds exactly two snapshots');

console.log('a damaged line loses itself and nothing else:');
fs.appendFileSync(file, 'this is not json\n');
fs.appendFileSync(file, JSON.stringify({ t: T + 1800, d: { 115: [31, 42, 83.3, 0.65] } }) + '\n');
ok(h.read().length === 3,                'the two good snapshots either side both survive');
ok(h.series(115).length === 3,           'and the series reads through the damage');

console.log('pruning keeps the window and rewrites atomically:');
h.append([{ id: 115, weightedSpreadBps: 12, tradableSpreadBps: 20, vwap: 1, concentration: 0.5 }], T - 40 * DAY);
ok(h.read().length === 4,                'the old snapshot is there to start with');
const p = h.prune(30, T + 1800);
ok(p.removed === 1,                      'one snapshot falls outside the window');
ok(h.read().length === 3,                'three remain');
ok(!fs.existsSync(file + '.tmp'),        'no temp file is left behind');
ok(h.prune(30, T + 1800).removed === 0,  'pruning again removes nothing');
ok(h.read().length === 3,                'and changes nothing');

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
