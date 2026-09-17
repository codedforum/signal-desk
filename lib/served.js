'use strict';
// express.static serves every file under public/, so anything left in that
// directory becomes a public URL whether or not the app links to it. A file
// dropped there by a one off task is then reachable by anyone who guesses the
// path, and nothing in the code would ever mention it. The app ships a known
// set, so the set is written down here and everything else answers 404.
//
// Keeping this list current is not optional bookkeeping: test/served.test.cjs
// compares it against the contents of public/ and fails in both directions, so
// a new asset must be added here and a stray file cannot sit there unnoticed.

const SHIPPED = new Set([
  '/', '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.webmanifest',
  '/img/ambient.mp4',
  '/img/hero.jpg',
  '/img/mark.png',
  '/img/mark-64.png',
]);

// The API is routed separately and must pass straight through to its handlers.
const isApi = (p) => p === '/api' || p.startsWith('/api/');

const isServed = (p) => typeof p === 'string' && (isApi(p) || SHIPPED.has(p));

module.exports = { SHIPPED, isApi, isServed };
