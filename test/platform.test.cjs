// Chain resolution, tested against a stubbed API. The interesting behaviour is
// not the happy path: it is that one unknown id rejects the whole batch, which
// is how a single delisted wrapper would otherwise blank the chain column for
// every asset on the board.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlatformMap, platformOf, parseBadId, chunk } = require('../lib/platform.js');
let fail = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL ' + m); fail++; } else console.log('  ok   ' + m); };

console.log('the offending id is parsed, never guessed:');
ok(parseBadId(`Invalid value for 'id': '39839'`) === '39839', 'the live message shape parses');
ok(parseBadId(`Invalid value for "id": "12"`) === '12',        'double quotes parse too');
ok(parseBadId('Invalid value for id: 77') === '77',            'and no quotes at all');
ok(parseBadId('some other failure') === null,                  'an unrelated message names nothing');
ok(parseBadId('') === null,                                    'an empty message names nothing');
ok(parseBadId(null) === null,                                  'nor does a missing one');

console.log('batching:');
ok(chunk([1, 2, 3, 4, 5], 2).length === 3,       'a list splits into groups');
ok(chunk([], 2).length === 0,                    'an empty list makes no groups');
ok(chunk([1, 2], 50)[0].length === 2,            'a short list stays one group');

console.log('a platform is a chain only when it is really a chain:');
ok(platformOf({ platform: { name: 'Ethereum', symbol: 'ETH' } }).chain === 'Ethereum', 'a real chain resolves');
ok(platformOf({ platform: { name: 'Ethereum', symbol: 'ETH' } }).publicChain === true, 'and counts as public');
ok(platformOf({ platform: { name: 'Robinhood', symbol: '-' } }).publicChain === false,
                                                  'a venue with no chain symbol is not a public chain');
ok(platformOf({ platform: { name: 'Robinhood', symbol: '-' } }).chain === 'Robinhood',
                                                  'but it is still named rather than hidden');
ok(platformOf({ platform: { name: 'Ondo', symbol: 'ONDO' } }, 'Ondo').publicChain === false,
                                                  'a platform matching its own issuer is a venue, not a network');
ok(platformOf({ platform: null }).chain === null, 'a null platform means native or off chain');
ok(platformOf(null).chain === null,               'and so does no record at all');
ok(platformOf(undefined).publicChain === false,   'which is never reported as public');

console.log('the map only fetches what it is missing:');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-plat-'));
const file = path.join(dir, 'nested', 'platforms.json');

const calls = [];
const stub = (behaviour) => ({
  call: async (url) => {
    const ids = decodeURIComponent(url.split('id=')[1]).split(',');
    calls.push(ids);
    return behaviour(ids);
  },
});
const good = stub((ids) => ({
  ok: true,
  data: Object.fromEntries(ids.map((id) => [id, { symbol: 'T' + id, platform: { name: 'Ethereum', symbol: 'ETH' } }])),
}));

(async () => {
  const pm = new PlatformMap(file);
  let r = await pm.fill(good, ['1', '2', '3']);
  ok(r.fetched === 3 && r.calls === 1,      'three unknown ids take one call');
  ok(pm.get('1').platform.name === 'Ethereum', 'and land in the map');
  ok(fs.existsSync(file),                   'the cache file is created');

  calls.length = 0;
  r = await pm.fill(good, ['1', '2', '3']);
  ok(r.fetched === 0 && r.calls === 0,      'asking again costs nothing');
  ok(calls.length === 0,                    'and makes no request at all');

  r = await pm.fill(good, ['1', '4']);
  ok(r.fetched === 1,                       'only the new id is fetched');

  const fresh = new PlatformMap(file);
  ok(fresh.get('4').platform.name === 'Ethereum', 'a restart reads the cache from disk');
  ok((await fresh.fill(good, ['1', '2', '3', '4'])).calls === 0, 'so a restart costs nothing either');

  console.log('one bad id must not blank the whole batch:');
  let seen = 0;
  const withBad = stub((ids) => {
    seen++;
    if (ids.includes('99')) return { ok: false, verdict: 'bad-request', msg: `Invalid value for 'id': '99'` };
    return { ok: true, data: Object.fromEntries(ids.map((id) => [id, { platform: { name: 'Base', symbol: 'ETH' } }])) };
  });
  const pm2 = new PlatformMap(path.join(dir, 'p2.json'));
  const r2 = await pm2.fill(withBad, ['10', '99', '11']);
  ok(r2.dropped.includes('99'),             'the bad id is identified and dropped');
  ok(r2.fetched === 2,                      'the other two still resolve');
  ok(pm2.get('10').platform.name === 'Base','and are usable');
  ok(pm2.get('99').unresolved === true,     'the bad id is remembered as unresolvable');
  const before = seen;
  await pm2.fill(withBad, ['99']);
  ok(seen === before,                       'so it is never asked for again');

  console.log('a failure it cannot attribute stops rather than loops:');
  let tries = 0;
  const broken = stub(() => { tries++; return { ok: false, verdict: 'http', msg: 'gateway exploded' }; });
  const pm3 = new PlatformMap(path.join(dir, 'p3.json'));
  const r3 = await pm3.fill(broken, ['5']);
  ok(tries === 1,                           'one attempt, not a retry storm');
  ok(r3.fetched === 0,                      'nothing is claimed as fetched');
  ok(r3.unresolved === 1,                   'and the one it could not resolve is reported as such');
  ok(pm3.get('5') === null,                 'and nothing is cached as known');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exit(fail ? 1 : 0);
})();
