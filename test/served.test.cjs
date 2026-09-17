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

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
