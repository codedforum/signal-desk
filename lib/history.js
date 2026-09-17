'use strict';
// Dislocation history.
//
// Every other number in this app is a live snapshot, which makes "TSM is 120
// basis points apart" unanswerable in the only way that matters: is that wide?
// The v5 endpoints return the present and nothing else, and no amount of credits
// buys last Tuesday, so the only way to have the answer later is to start
// writing it down now.
//
// One line per snapshot rather than one per asset, because the whole board is
// about a kilobyte and a hundred thousand tiny records is not.

const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60;
// Thirty days is enough to say whether today is unusual without the file
// becoming something that needs a database behind it.
const RETAIN_DAYS = 30;
// A reading needs company before "unusual" means anything. Below this the
// product says it does not know yet, which is the honest answer in week one.
const MIN_READINGS = 12;

const nowSec = () => Math.floor(Date.now() / 1000);

/* ------------------------------ statistics ------------------------------ */
// Pure over plain arrays, so the interesting part is testable without touching
// a disk or waiting a month for data to exist.

const sorted = (nums) => [...nums].sort((a, b) => a - b);

function quantile(nums, q) {
  if (!nums.length) return null;
  const s = sorted(nums);
  if (s.length === 1) return s[0];
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// Where a value sits in its own past, as a fraction from 0 to 1. Ties count as
// half so that a flat series reports the middle rather than either extreme.
function percentileOf(nums, value) {
  if (!nums.length || typeof value !== 'number' || !isFinite(value)) return null;
  let below = 0, equal = 0;
  for (const n of nums) {
    if (n < value) below++;
    else if (n === value) equal++;
  }
  return (below + equal / 2) / nums.length;
}

// What the app says about one reading against its own history. Returns null
// rather than a verdict when there is not enough past to have an opinion.
function verdict(nums, value) {
  if (!Array.isArray(nums) || nums.length < MIN_READINGS) return null;
  const pct = percentileOf(nums, value);
  if (pct == null) return null;
  return {
    readings: nums.length,
    percentile: pct,
    median: quantile(nums, 0.5),
    p90: quantile(nums, 0.9),
    max: Math.max(...nums),
    min: Math.min(...nums),
    // Named bands rather than a bare number, because "0.97" is not a sentence.
    band: pct >= 0.98 ? 'widest on record'
        : pct >= 0.90 ? 'unusually wide'
        : pct <= 0.10 ? 'unusually tight'
        : 'normal',
  };
}

/* -------------------------------- storage ------------------------------- */

class SpreadHistory {
  constructor(file) {
    this.file = file;
  }

  // Each record is [weightedBps, rawBps, vwap, concentration], keyed by asset
  // id, under one timestamp. Rounded on the way in: storing fourteen decimal
  // places of a basis point measurement is storing noise.
  append(rows, at = nowSec()) {
    const d = {};
    for (const r of rows) {
      if (r == null || r.id == null || typeof r.weightedSpreadBps !== 'number') continue;
      d[r.id] = [
        Math.round(r.weightedSpreadBps * 10) / 10,
        Math.round((r.tradableSpreadBps ?? 0) * 10) / 10,
        r.vwap == null ? null : Math.round(r.vwap * 1e4) / 1e4,
        r.concentration == null ? null : Math.round(r.concentration * 1e3) / 1e3,
      ];
    }
    if (!Object.keys(d).length) return 0;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ t: at, d }) + '\n');
    return Object.keys(d).length;
  }

  // A malformed line is skipped rather than thrown, because one bad append
  // from a half written flush should not take the whole history with it.
  read(sinceSec = 0) {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.t === 'number' && rec.t >= sinceSec && rec.d) out.push(rec);
      } catch { /* skip the damaged line, keep the rest */ }
    }
    return out;
  }

  // The series for one asset, oldest first.
  series(id, sinceSec = 0) {
    const key = String(id);
    const out = [];
    for (const rec of this.read(sinceSec)) {
      const v = rec.d[key];
      if (!v) continue;
      out.push({ t: rec.t, weighted: v[0], raw: v[1], vwap: v[2], concentration: v[3] });
    }
    return out;
  }

  // Rewrites the file without anything older than the retention window. Writes
  // to a temp path and renames, so an interrupted prune cannot leave a
  // truncated history behind.
  prune(retainDays = RETAIN_DAYS, at = nowSec()) {
    const cutoff = at - retainDays * DAY;
    const kept = this.read(cutoff);
    const before = this.read(0).length;
    if (kept.length === before) return { before, after: before, removed: 0 };
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
    fs.renameSync(tmp, this.file);
    return { before, after: kept.length, removed: before - kept.length };
  }
}

module.exports = {
  SpreadHistory, percentileOf, quantile, verdict,
  RETAIN_DAYS, MIN_READINGS, DAY,
};
