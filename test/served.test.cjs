// The public directory and the shipped file list must agree. This fails in both
// directions on purpose: a new asset nobody allowlisted would 404 in production,
// and a stray file nobody meant to publish would be served to anyone who
// guessed its path. One of those happened, which is why this test exists.
const fs = require('fs');
const path = require('path');
const { SHIPPED, isServed, isApi } = require('../lib/served.js');
let fail = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL ' + m); fail++; } else console.log('  ok   ' + m); };

const PUB = path.join(__dirname, '..', 'public');
const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name), base + '/' + e.name) : [base + '/' + e.name]);
const onDisk = walk(PUB).sort();

console.log('every file in public/ is one the app means to publish:');
for (const f of onDisk) ok(SHIPPED.has(f), `public${f} is on the shipped list`);

console.log('every entry on the list still exists, so none is a stale promise:');
for (const entry of [...SHIPPED].filter((e) => e !== '/')) {
  ok(fs.existsSync(path.join(PUB, entry)), `${entry} exists on disk`);
}

console.log('the guard lets through exactly what it should:');
ok(isServed('/'),                     'the page itself');
ok(isServed('/app.js'),               'the client script');
ok(isServed('/img/ambient.mp4'),      'the ambient video');
ok(isApi('/api/health'),              'an api path is recognised as api');
ok(isServed('/api/rwa/asset/115'),    'and passes through to its handler');
ok(isServed('/api'),                  'the bare api prefix passes too');

console.log('and refuses everything else:');
for (const bad of ['/tmpmedia/face-ref.jpg', '/.env', '/server.js', '/package.json',
                   '/node_modules/express/package.json', '/img/', '/img/secret.png',
                   '/run.log', '/../server.js', '/APP.JS', '/app.js.bak', '/index.html~']) {
  ok(!isServed(bad), `${bad} is refused`);
}

console.log('a non string path cannot slip past the check:');
for (const bad of [null, undefined, 42, {}, []]) ok(!isServed(bad), `${JSON.stringify(bad)} is refused`);

console.log('the first screen gives an RWA judge a complete one minute route:');
const page = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
ok(page.includes('<title>Signal Desk | RWA market intelligence</title>'), 'the page title names the RWA product');
ok(page.includes('id="judge-path"'), 'the judge path is present on the first screen');
ok(page.includes('Build with CMC, Real World Assets track'), 'the selected track is explicit');
ok(page.includes('Judge it in 60 seconds'), 'the short evaluation route is named');
ok(page.includes('href="#rwa"'), 'the route opens the RWA desk');
ok(page.includes('href="#api"'), 'the route opens live API evidence');
ok(page.includes('https://youtu.be/MmMq6c6H_Lg'), 'the demo video is linked');
ok(page.includes('https://github.com/codedforum/signal-desk'), 'the public source is linked');
ok(page.includes('https://dorahacks.io/hackathon/coinmarketcap-api-202609/buidl'), 'the hackathon entry list is linked');
ok(page.indexOf('data-view="rwa"') < page.indexOf('data-view="desk"'), 'RWA leads the wide navigation');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
