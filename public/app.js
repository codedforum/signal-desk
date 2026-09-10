/* Signal Desk client.
   Draws whatever the API actually returned. A panel whose endpoint the plan
   refuses says so plainly rather than rendering an empty box, because an empty
   box reads as broken and a refusal is not. */
'use strict';

const $ = (s) => document.querySelector(s);
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };

const usd = (n) => {
  if (n == null || !isFinite(n)) return 'n/a';
  const a = Math.abs(n);
  if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9)  return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6)  return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3)  return '$' + (n / 1e3).toFixed(1) + 'K';
  if (a >= 1)    return '$' + n.toFixed(2);
  return '$' + n.toPrecision(3);
};
// A sign on a number is meaningful, so it is kept.
const pct = (n) => (n == null || !isFinite(n)) ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(2) + '%';
const cls = (n) => n > 0 ? 'up' : n < 0 ? 'dn' : '';

function stat(dl, label, value, klass) {
  const wrap = el('div');
  wrap.append(el('dt', null, label));
  const dd = el('dd', klass || null, value);
  wrap.append(dd);
  dl.append(wrap);
}

function renderRegime(r) {
  if (!r) {
    $('#regime-stance').textContent = 'unavailable';
    $('#regime-why').textContent = 'The global metrics endpoint did not return. Check the capability panel below.';
    return;
  }
  $('#regime-stance').textContent = r.stance;
  $('#regime-why').textContent = r.why;
  const dl = $('#regime-stats'); dl.textContent = '';
  stat(dl, 'total market cap', usd(r.totalMarketCap));
  stat(dl, '24h change', pct(r.mcapChange24h), cls(r.mcapChange24h));
  stat(dl, '24h volume', usd(r.volume24h));
  stat(dl, 'btc dominance', r.btcDominance ? r.btcDominance.toFixed(1) + '%' : 'n/a');
  stat(dl, 'eth dominance', r.ethDominance ? r.ethDominance.toFixed(1) + '%' : 'n/a');
  if (r.fearGreed) stat(dl, 'fear and greed', r.fearGreed + (r.fearGreedLabel ? ' ' + r.fearGreedLabel.toLowerCase() : ''));
}

// Sentiment and participation disagree more often than either alone admits, and
// that disagreement is the most useful thing on the page. Surfaced, not buried.
function renderDivergence(r, b) {
  const box = document.querySelector('#regime-divergence');
  if (!r || !b || !r.fearGreed) { box.hidden = true; return; }
  const greedy = r.fearGreed >= 60, fearful = r.fearGreed <= 40;
  const thin = b.advancePct <= 35, broad = b.advancePct >= 65;
  let msg = null;
  if (greedy && thin) {
    msg = `Sentiment reads <b>${r.fearGreedLabel || 'greed'} at ${r.fearGreed}</b>, but only <b>${b.advancePct}%</b> of the top ${b.sampled} is advancing and the median name is ${pct(b.median24h)}. Mood and participation disagree.`;
  } else if (fearful && broad) {
    msg = `Sentiment reads <b>${r.fearGreedLabel || 'fear'} at ${r.fearGreed}</b> while <b>${b.advancePct}%</b> of the top ${b.sampled} is advancing. Participation is better than the mood suggests.`;
  }
  if (!msg) { box.hidden = true; return; }
  box.innerHTML = msg;
  box.hidden = false;
}

function renderBreadth(b) {
  const dl = $('#breadth-stats'); dl.textContent = '';
  if (!b) { dl.append(el('div', 'skel', 'listings endpoint unavailable')); return; }
  $('#bb-up').style.width = b.advancePct + '%';
  $('#bb-dn').style.width = (100 - b.advancePct) + '%';
  stat(dl, 'advancing', b.advancing + ' of ' + b.sampled, b.advancePct >= 50 ? 'up' : '');
  stat(dl, 'participation', b.advancePct.toFixed(1) + '%', b.advancePct >= 50 ? 'up' : 'dn');
  stat(dl, 'median 24h', pct(b.median24h), cls(b.median24h));
  stat(dl, 'up over 5%', String(b.strongGainers), 'up');
  stat(dl, 'down over 5%', String(b.strongLosers), 'dn');
}

function renderChains(c) {
  const ul = $('#chain-list'); ul.textContent = '';
  if (!c || !c.highlighted || !c.highlighted.length) {
    ul.append(el('li', 'skel', 'platform list unavailable'));
    return;
  }
  for (const h of c.highlighted) {
    const li = el('li');
    li.append(el('span', 'cname', h.name));
    li.append(el('span', 'cid', 'platform id ' + h.id));
    ul.append(li);
  }
  $('#chain-total').textContent = c.total + ' networks indexed by CoinMarketCap';
}

function renderRotation(rows) {
  const tb = $('#rotation-table tbody'); tb.textContent = '';
  if (!rows || !rows.length) {
    const tr = el('tr'); const td = el('td', 'skel', 'categories endpoint unavailable'); td.colSpan = 4; tr.append(td); tb.append(tr); return;
  }
  for (const r of rows) {
    const tr = el('tr');
    tr.append(el('td', null, r.name));
    const t = el('td', 'num', String(r.tokens)); tr.append(t);
    tr.append(el('td', 'num', usd(r.marketCap)));
    tr.append(el('td', 'num ' + cls(r.change24h), pct(r.change24h)));
    tb.append(tr);
  }
}

function renderMovers(sel, rows) {
  const tb = document.querySelector(sel + ' tbody'); tb.textContent = '';
  if (!rows || !rows.length) {
    const tr = el('tr'); const td = el('td', 'skel', 'no data'); td.colSpan = 4; tr.append(td); tb.append(tr); return;
  }
  for (const r of rows) {
    const tr = el('tr');
    const first = el('td');
    if (r.rank) first.append(el('span', 'rank', '#' + r.rank));
    first.append(el('span', 'sym', r.symbol));
    first.append(el('span', 'nm', r.name));
    tr.append(first);
    tr.append(el('td', 'num', usd(r.price)));
    tr.append(el('td', 'num ' + cls(r.change24h), pct(r.change24h)));
    tr.append(el('td', 'num ' + cls(r.change7d), pct(r.change7d)));
    tb.append(tr);
  }
}

function renderCapability(cap) {
  const ul = $('#cap-list'); ul.textContent = '';
  if (!cap || !cap.checks) { ul.append(el('li', 'skel', 'capability probe failed')); return; }
  for (const c of cap.checks) {
    const li = el('li');
    const k = c.verdict === 'ok' ? 'ok' : c.verdict === 'plan' ? 'plan' : 'bad';
    li.append(el('span', 'dot ' + k));
    li.append(el('span', 'ep', c.method + ' ' + c.path));
    li.append(el('span', 'vd', c.verdict === 'ok' ? 'reachable' : c.verdict === 'plan' ? 'needs a paid plan' : c.verdict));
    ul.append(li);
  }
  const gated = cap.gated ? cap.gated.length : 0;
  $('#pill-plan').textContent = gated ? gated + ' endpoints need a paid plan' : 'all probed endpoints reachable';
  $('#pill-plan').className = 'pill ' + (gated ? 'warn' : 'good');
}

async function load() {
  try {
    const r = await fetch('/api/signal').then((x) => x.json());
    if (!r.ok) throw new Error(r.error || 'signal failed');
    renderRegime(r.regime);
    renderBreadth(r.breadth);
    renderDivergence(r.regime, r.breadth);
    renderChains(r.chains);
    renderRotation(r.rotation);
    renderMovers('#gainers-table', r.movers && r.movers.gainers);
    renderMovers('#losers-table', r.movers && r.movers.losers);

    const t = new Date(r.at);
    $('#pill-clock').textContent = 'updated ' + t.toUTCString().slice(17, 25) + ' UTC';
    if (r.usage) {
      $('#pill-credits').textContent = r.usage.creditsUsed + ' credits this session';
      $('#foot-usage').textContent =
        `${r.usage.calls} calls, ${r.usage.creditsUsed} credits, key ${r.usage.hasKey ? 'present' : 'missing'}`;
    }
  } catch (e) {
    $('#regime-stance').textContent = 'offline';
    $('#regime-why').textContent = String(e.message);
  }

  try {
    renderCapability(await fetch('/api/capability').then((x) => x.json()));
  } catch { renderCapability(null); }
}

load();
// The server caches for five minutes, so polling faster than that spends nothing
// and shows nothing new.
setInterval(load, 5 * 60 * 1000);
