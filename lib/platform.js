'use strict';
// Which chain each wrapper actually lives on.
//
// The RWA quotes payload names the issuer but not the network, so a 378 basis
// point gap between two wrappers looks like one number when it is really two
// facts: a price difference, and whether anything could ever move between them.
// Tokenised TSM is cheapest on Robinhood's own closed venue and dearest on
// Ethereum, which is not a spread anyone can act on.
//
// Each token carries a crypto_id, and /v2/cryptocurrency/info turns that into a
// platform. A token's chain does not change, so the map is cached on disk and
// the steady state cost is nothing.

const fs = require('fs');
const path = require('path');

// Generous, since the endpoint accepts well over a hundred. The cap exists to
// bound the damage when a batch has to be retried, not because of a limit.
const CHUNK = 120;
// One unknown id rejects the WHOLE batch, so bad ids are dropped and the call
// retried. Bounded, because a request that keeps failing for another reason
// must stop rather than loop.
const MAX_RETRIES = 6;

const chunk = (arr, n = CHUNK) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// `Invalid value for 'id': '39839'`. Parsed rather than guessed at, so a
// message in another shape leaves the batch alone instead of dropping a random id.
function parseBadId(msg) {
  const m = String(msg || '').match(/Invalid value for\s+['"]?id['"]?\s*:\s*['"]?(\d+)/i);
  return m ? m[1] : null;
}

// A platform of null means the coin is native to its own chain or lives off
// chain entirely. A platform whose name matches the issuer is a venue rather
// than a public network, which is the case that matters here.
function platformOf(record, issuerName) {
  const p = record && record.platform;
  if (!p || !p.name) return { chain: null, chainSymbol: null, publicChain: false };
  const name = String(p.name);
  const sym = p.symbol ? String(p.symbol) : null;
  const closed = !sym || sym === '-' ||
    (issuerName && name.toLowerCase() === String(issuerName).toLowerCase());
  return { chain: name, chainSymbol: sym, publicChain: !closed };
}

class PlatformMap {
  constructor(file) {
    this.file = file;
    this.map = {};
    try { this.map = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { this.map = {}; }
  }

  get(id) { return this.map[String(id)] || null; }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.map));
      fs.renameSync(tmp, this.file);
    } catch { /* a cache that cannot be written is still a working cache */ }
  }

  // Resolves only what is missing. Returns how many were fetched, so a caller
  // can see whether a board refresh cost anything at all.
  async fill(cmc, ids) {
    const want = [...new Set(ids.map(String).filter((x) => x && x !== 'undefined'))]
      .filter((id) => !this.map[id]);
    if (!want.length) return { fetched: 0, calls: 0, dropped: [] };

    let calls = 0;
    // Counted as records that actually landed, never as the batch minus its
    // known failures. A call that fails for a reason this cannot attribute
    // resolves nothing, and saying otherwise would report success for doing
    // nothing at all.
    let fetched = 0;
    const dropped = [];
    for (const group of chunk(want)) {
      let batch = group;
      for (let attempt = 0; attempt <= MAX_RETRIES && batch.length; attempt++) {
        const r = await cmc.call(`/v2/cryptocurrency/info?id=${batch.join(',')}`,
          { name: `platform:${batch[0]}:${batch.length}` });
        calls++;
        if (r.ok && r.data) {
          for (const [id, rec] of Object.entries(r.data)) { this.map[id] = rec; fetched++; }
          break;
        }
        const bad = parseBadId(r.msg);
        if (!bad) break;                       // a failure we cannot attribute
        dropped.push(bad);
        // Remembered as unresolvable, so the next board does not ask again.
        this.map[bad] = { platform: null, unresolved: true };
        batch = batch.filter((x) => x !== bad);
      }
    }
    this.save();
    return { fetched, calls, dropped, unresolved: want.length - fetched };
  }
}

module.exports = { PlatformMap, platformOf, parseBadId, chunk, CHUNK, MAX_RETRIES };
