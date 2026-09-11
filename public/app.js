/* Signal Desk client.
   Draws whatever the API actually returned. A panel whose endpoint the plan
   refuses says so plainly rather than rendering an empty box, because an empty
   box reads as broken and a refusal is not. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const usd = (n) => {
  if (n == null || !isFinite(n)) return 'n/a';
  const a = Math.abs(n);
  if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9)  return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6)  return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3)  return '$' + (n / 1e3).toFixed(1) + 'K';
  if (a >= 1)    return '$' + n.toFixed(2);
  return '$' + Number(n).toPrecision(3);
};
// A sign on a number is meaningful, so it is kept.
const pct = (n) => (n == null || !isFinite(n)) ? 'n/a' : (n > 0 ? '+' : '') + Number(n).toFixed(2) + '%';
const cls = (n) => n > 0 ? 'up' : n < 0 ? 'dn' : '';
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('sd:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sd:' + k, JSON.stringify(v)); } catch {} },
};

let SIGNAL = null;
let LISTINGS = [];
let CHAINS = [];

/* ======================= modal, toast, tape ========================= */

let modalLast = null;   // element to restore focus to on close

function openModal(title, sub, build) {
  const m = $('#modal'), bd = $('#modal-backdrop');
  modalLast = document.activeElement;
  $('#modal-title').textContent = title;
  $('#modal-sub').textContent = sub || '';
  const body = $('#modal-body'); body.textContent = '';
  build(body);
  m.hidden = false; bd.hidden = false;
  document.body.style.overflow = 'hidden';
  $('#modal-x').focus();
}

function closeModal() {
  const m = $('#modal'), bd = $('#modal-backdrop');
  if (m.hidden) return;
  m.hidden = true; bd.hidden = true;
  document.body.style.overflow = '';
  if (modalLast && modalLast.focus) modalLast.focus();
}

function toast(msg) {
  const wrap = $('#toasts'); if (!wrap) return;
  const t = el('div', 'toast', msg);
  wrap.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 2600);
}

// Detail for one asset, priced live at the moment it is opened.
async function openAsset(symbol) {
  openModal(symbol, 'loading live quote', (body) => {
    for (let i = 0; i < 4; i++) body.append(el('div', 'shimmer'), el('div', null, ' '));
  });
  try {
    const r = await fetch('api/quote?symbol=' + encodeURIComponent(symbol)).then((x) => x.json());
    const a = r.ok && r.data && r.data[0];
    if (!a) { $('#modal-body').textContent = ''; $('#modal-body').append(el('p', 'skel', 'no quote returned for ' + symbol)); return; }
    $('#modal-title').textContent = a.symbol;
    $('#modal-sub').textContent = `${a.name}${a.rank ? ', rank ' + a.rank : ''}`;
    const body = $('#modal-body'); body.textContent = '';

    const price = el('p', 'modal-price', usd(a.price)); body.append(price);
    const chg = el('p', 'stance-why ' + cls(a.change24h), pct(a.change24h) + ' over 24 hours');
    chg.style.margin = '0 0 6px'; body.append(chg);

    // The free tier has no historical series, so this is the four changes the
    // quote already returns, drawn to scale. Honest about what it is.
    const spark = el('div', 'modal-spark');
    const pts = [a.change30d, a.change7d, a.change24h, a.change1h].map((v) => Number(v) || 0);
    const span = Math.max(1, ...pts.map(Math.abs));
    pts.forEach((v, i) => {
      const b = el('i');
      b.style.height = Math.max(6, (Math.abs(v) / span) * 100) + '%';
      b.style.animationDelay = (i * 0.06) + 's';
      if (v < 0) b.style.background = 'linear-gradient(180deg,var(--dn),rgba(239,68,68,.25))';
      spark.append(b);
    });
    body.append(spark);
    const lbl = el('p', 'foot', '30d, 7d, 24h, 1h change, drawn to scale');
    lbl.style.margin = '0 0 14px'; body.append(lbl);

    const grid = el('div', 'mgrid');
    const cell = (k, v, c) => {
      const d = el('div');
      d.append(el('div', 'mk', k));
      d.append(el('div', 'mv ' + (c || ''), v));
      grid.append(d);
    };
    cell('1 hour', pct(a.change1h), cls(a.change1h));
    cell('24 hours', pct(a.change24h), cls(a.change24h));
    cell('7 days', pct(a.change7d), cls(a.change7d));
    cell('30 days', pct(a.change30d), cls(a.change30d));
    cell('market cap', usd(a.marketCap));
    cell('24h volume', usd(a.volume24h));
    cell('circulating', a.supply ? Math.round(a.supply).toLocaleString() : 'n/a');
    cell('max supply', a.maxSupply ? Math.round(a.maxSupply).toLocaleString() : 'uncapped');
    body.append(grid);

    const acts = el('div', 'modal-actions');
    const w = el('button', null, 'Add to watchlist');
    w.onclick = () => { addWatch(a.symbol); toast(a.symbol + ' added to your watchlist'); };
    const al = el('button', 'mini', 'Alert above ' + usd(a.price));
    al.onclick = () => { addAlert(a.symbol, 'above', a.price); toast('Alert set on ' + a.symbol); };
    acts.append(w, al); body.append(acts);
  } catch (e) {
    $('#modal-body').textContent = '';
    $('#modal-body').append(el('p', 'skel', 'lookup failed: ' + e.message));
  }
}

// Rows become tappable, which is what a phone user expects of a list.
function makeRowOpen(tr, symbol) {
  tr.dataset.sym = symbol;
  tr.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;   // let row buttons do their own job
    openAsset(symbol);
  });
}

/* ---- live ticker tape, duplicated so the loop has no visible seam ---- */
function renderTape(rows) {
  const track = $('#tape-track'); if (!track || !rows || !rows.length) return;
  track.textContent = '';
  const items = rows.slice(0, 22);
  for (let pass = 0; pass < 2; pass++) {
    for (const r of items) {
      const i = el('span', 'tape-item');
      i.append(el('span', 'ts', r.symbol));
      i.append(el('span', 'tp', usd(r.price)));
      i.append(el('span', cls(r.change24h), pct(r.change24h)));
      i.addEventListener('click', () => openAsset(r.symbol));
      i.style.cursor = 'pointer';
      track.append(i);
    }
  }
}

/* ---- flash a value that moved since the last refresh ---- */
const lastSeen = new Map();
function flashIfChanged(node, key, value) {
  const prev = lastSeen.get(key);
  if (prev != null && value != null && prev !== value) {
    node.classList.remove('flash-up', 'flash-dn');
    void node.offsetWidth;
    node.classList.add(value > prev ? 'flash-up' : 'flash-dn');
  }
  if (value != null) lastSeen.set(key, value);
}

/* ============================== router ============================== */

const VIEWS = ['desk', 'rotation', 'screener', 'portfolio', 'rwa', 'chains', 'api'];

function moveInk(link) {
  const ink = $('#menu-ink'), menu = $('#menu');
  if (!ink || !link) return;
  const a = link.getBoundingClientRect(), m = menu.getBoundingClientRect();
  ink.style.width = a.width + 'px';
  ink.style.transform = `translateX(${a.left - m.left + menu.scrollLeft}px)`;
}

function show(view) {
  if (!VIEWS.includes(view)) view = 'desk';
  VIEWS.forEach((v) => { const n = $('#view-' + v); if (n) n.hidden = v !== view; });
  $$('#menu a, .botnav a, .more-sheet a').forEach((a) => a.classList.toggle('on', a.dataset.view === view));
  moveInk($(`#menu a[data-view="${view}"]`));
  closeSheet();
  // A tab bar is expected to return you to the top of the section, the way a
  // native app does, rather than leaving you mid scroll from the last view.
  if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: REDUCED ? 'auto' : 'smooth' });
  const node = $('#view-' + view);
  if (node && !REDUCED) { node.classList.remove('entering'); void node.offsetWidth; node.classList.add('entering'); }
  // A canvas that has been display:none can come back blank: the drawing buffer
  // is not guaranteed to survive, and a software WebGL context can be lost under
  // memory pressure without throwing. Re-entering the view therefore resizes and
  // redraws rather than trusting whatever is still on the canvas.
  if (view === 'rotation') { initThree(); if (threeRefresh) requestAnimationFrame(threeRefresh); }
  if (view === 'chains') loadChains();
  if (view === 'rwa') loadRwa();
  if (view === 'screener') renderScreen();
  if (view === 'portfolio') { renderPortfolio(); renderAlerts(); }
}

/* ---- overflow sheet, the mobile home for views the tab bar cannot hold ---- */
function openSheet() {
  const sh = $('#more-sheet'), bd = $('#sheet-backdrop'), btn = $('#more-btn');
  if (!sh) return;
  sh.hidden = false; bd.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  const sh = $('#more-sheet'), bd = $('#sheet-backdrop'), btn = $('#more-btn');
  if (!sh || sh.hidden) return;
  sh.hidden = true; bd.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
}

addEventListener('hashchange', () => show(location.hash.slice(1)));
addEventListener('resize', () => moveInk($('#menu a.on')));

/* ============================ animation ============================= */

// Count a number up rather than snapping it in. Cheap, and it makes a refresh
// legible: you can see which figures actually moved.
function countUp(node, to, fmt, ms = 700) {
  if (REDUCED || !isFinite(to)) { node.textContent = fmt(to); return; }
  const from = Number(node.dataset.v || 0), t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms), eased = 1 - Math.pow(1 - k, 3);
    node.textContent = fmt(from + (to - from) * eased);
    if (k < 1) requestAnimationFrame(step); else node.dataset.v = to;
  };
  requestAnimationFrame(step);
}

function stat(dl, label, value, klass) {
  const wrap = el('div');
  wrap.append(el('dt', null, label));
  wrap.append(el('dd', klass || null, value));
  dl.append(wrap);
}

/* ============================== gauge =============================== */

function drawGauge(value, label) {
  const c = $('#gauge'); if (!c) return;
  const ctx = c.getContext('2d');
  const W = c.width, cx = W / 2, cy = W / 2, r = W / 2 - 26;
  const START = Math.PI * 0.75, SWEEP = Math.PI * 1.5;
  const target = Math.max(0, Math.min(100, Number(value) || 0));

  const paint = (v) => {
    ctx.clearRect(0, 0, W, W);
    ctx.lineCap = 'round'; ctx.lineWidth = 14;
    ctx.strokeStyle = '#22252e';
    ctx.beginPath(); ctx.arc(cx, cy, r, START, START + SWEEP); ctx.stroke();
    const g = ctx.createLinearGradient(0, 0, W, W);
    g.addColorStop(0, '#ef4444'); g.addColorStop(0.5, '#f97316'); g.addColorStop(1, '#22c55e');
    ctx.strokeStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, START, START + SWEEP * (v / 100)); ctx.stroke();
    const a = START + SWEEP * (v / 100);
    ctx.strokeStyle = '#eef0f5'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * (r - 22), cy + Math.sin(a) * (r - 22)); ctx.stroke();
    ctx.fillStyle = '#eef0f5'; ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
  };

  if (REDUCED) paint(target);
  else {
    const t0 = performance.now();
    const run = (t) => {
      const k = Math.min(1, (t - t0) / 900);
      paint(target * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(run);
    };
    requestAnimationFrame(run);
  }
  const v = $('#gauge-val'); if (v) countUp(v, target, (n) => String(Math.round(n)));
  const l = $('#gauge-lab'); if (l) l.textContent = label || 'sentiment';
}

/* ============================== desk ================================ */

function renderRegime(r) {
  if (!r) {
    $('#regime-stance').textContent = 'unavailable';
    $('#regime-why').textContent = 'Global metrics did not return. See the API view.';
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
  stat(dl, 'assets tracked', r.activeCryptos ? r.activeCryptos.toLocaleString() : 'n/a');
  drawGauge(r.fearGreed, r.fearGreedLabel || 'sentiment');
}

// Sentiment and participation disagree more often than either alone admits, and
// that disagreement is the most useful thing on the page. Surfaced, not buried.
function renderDivergence(r, b) {
  const box = $('#regime-divergence');
  if (!r || !b || !r.fearGreed) { box.hidden = true; return; }
  let msg = null;
  if (r.fearGreed >= 60 && b.advancePct <= 35) {
    msg = `Sentiment reads <b>${r.fearGreedLabel || 'greed'} at ${r.fearGreed}</b>, but only <b>${b.advancePct}%</b> of the top ${b.sampled} is advancing and the median name is ${pct(b.median24h)}. Mood and participation disagree.`;
  } else if (r.fearGreed <= 40 && b.advancePct >= 65) {
    msg = `Sentiment reads <b>${r.fearGreedLabel || 'fear'} at ${r.fearGreed}</b> while <b>${b.advancePct}%</b> is advancing. Participation is better than the mood suggests.`;
  }
  if (!msg) { box.hidden = true; return; }
  box.innerHTML = msg; box.hidden = false;
}

function renderBreadth(b) {
  const dl = $('#breadth-stats'); dl.textContent = '';
  if (!b) { dl.append(el('div', 'skel', 'listings unavailable')); return; }
  requestAnimationFrame(() => {
    $('#bb-up').style.width = b.advancePct + '%';
    $('#bb-dn').style.width = (100 - b.advancePct) + '%';
  });
  stat(dl, 'advancing', b.advancing + ' of ' + b.sampled, b.advancePct >= 50 ? 'up' : '');
  stat(dl, 'participation', b.advancePct.toFixed(1) + '%', b.advancePct >= 50 ? 'up' : 'dn');
  stat(dl, 'median 24h', pct(b.median24h), cls(b.median24h));
  stat(dl, 'up over 5%', String(b.strongGainers), 'up');
  stat(dl, 'down over 5%', String(b.strongLosers), 'dn');
}

function assetCell(r) {
  const td = el('td');
  if (r.rank) td.append(el('span', 'rank', '#' + r.rank));
  td.append(el('span', 'sym', r.symbol));
  td.append(el('span', 'nm', r.name));
  return td;
}

/* ============================= screener ============================= */

function renderScreen() {
  const tb = $('#screen-table tbody'); if (!tb) return;
  tb.textContent = '';
  const q = ($('#f-q').value || '').trim().toLowerCase();
  const min = parseFloat($('#f-min').value), max = parseFloat($('#f-max').value);
  const vol = parseFloat($('#f-vol').value), sortBy = $('#f-sort').value;

  const rows = LISTINGS.filter((r) => {
    if (q && !`${r.symbol} ${r.name}`.toLowerCase().includes(q)) return false;
    if (isFinite(min) && !(r.change24h >= min)) return false;
    if (isFinite(max) && !(r.change24h <= max)) return false;
    if (isFinite(vol) && !((r.volume24h || 0) >= vol)) return false;
    return true;
  }).sort((a, b) => (b[sortBy] ?? 0) - (a[sortBy] ?? 0));

  $('#f-count').textContent = `${rows.length} of ${LISTINGS.length} shown, filtered locally`;
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="8" class="skel">nothing matches those filters</td></tr>'; return; }
  for (const r of rows.slice(0, 120)) {
    const tr = el('tr');
    makeRowOpen(tr, r.symbol);
    tr.append(assetCell(r));
    tr.append(el('td', 'num', usd(r.price)));
    tr.append(el('td', 'num ' + cls(r.change1h), pct(r.change1h)));
    tr.append(el('td', 'num ' + cls(r.change24h), pct(r.change24h)));
    tr.append(el('td', 'num ' + cls(r.change7d), pct(r.change7d)));
    tr.append(el('td', 'num', usd(r.volume24h)));
    tr.append(el('td', 'num', usd(r.marketCap)));
    const act = el('td'), b = el('button', 'mini', 'watch');
    b.onclick = () => { addWatch(r.symbol); b.textContent = 'added'; };
    act.append(b); tr.append(act);
    tb.append(tr);
  }
}

/* ============================= watchlist ============================ */

const getWatch = () => store.get('watch', ['BTC', 'ETH', 'SOL']);
function addWatch(sym) {
  sym = String(sym || '').trim().toUpperCase(); if (!sym) return;
  const w = getWatch(); if (!w.includes(sym)) w.push(sym);
  store.set('watch', w.slice(0, 40)); loadWatch();
}
function delWatch(sym) { store.set('watch', getWatch().filter((s) => s !== sym)); loadWatch(); }

async function loadWatch() {
  const tb = $('#watch-table tbody'); if (!tb) return;
  const syms = getWatch();
  if (!syms.length) { tb.innerHTML = '<tr><td colspan="5" class="skel">watchlist empty</td></tr>'; return; }
  try {
    const r = await fetch('api/quote?symbol=' + encodeURIComponent(syms.join(','))).then((x) => x.json());
    tb.textContent = '';
    if (!r.ok) { tb.innerHTML = `<tr><td colspan="5" class="skel">${r.verdict === 'plan' ? 'quotes need a paid plan' : 'quote lookup failed'}</td></tr>`; return; }
    for (const a of r.data) {
      const tr = el('tr');
      makeRowOpen(tr, a.symbol);
      tr.append(assetCell(a));
      const pxCell = el('td', 'num', usd(a.price));
      flashIfChanged(pxCell, 'w:' + a.symbol, a.price);
      tr.append(pxCell);
      tr.append(el('td', 'num ' + cls(a.change24h), pct(a.change24h)));
      tr.append(el('td', 'num ' + cls(a.change7d), pct(a.change7d)));
      const td = el('td'), b = el('button', 'mini', 'remove');
      b.onclick = () => delWatch(a.symbol);
      td.append(b); tr.append(td); tb.append(tr);
    }
    checkAlerts(r.data);
  } catch { tb.innerHTML = '<tr><td colspan="5" class="skel">offline</td></tr>'; }
}

/* ============================= portfolio ============================ */

const getPos = () => store.get('positions', []);
function addPos(sym, qty, cost) {
  const p = getPos();
  p.push({ sym: String(sym).toUpperCase(), qty: Number(qty), cost: Number(cost) });
  store.set('positions', p); renderPortfolio();
}
function delPos(i) { const p = getPos(); p.splice(i, 1); store.set('positions', p); renderPortfolio(); }

async function renderPortfolio() {
  const tb = $('#pf-table tbody'), dl = $('#pf-stats'); if (!tb) return;
  const pos = getPos();
  dl.textContent = ''; tb.textContent = '';
  if (!pos.length) { tb.innerHTML = '<tr><td colspan="8" class="skel">no holdings yet</td></tr>'; return; }
  const syms = [...new Set(pos.map((p) => p.sym))];
  try {
    const r = await fetch('api/quote?symbol=' + encodeURIComponent(syms.join(','))).then((x) => x.json());
    if (!r.ok) { tb.innerHTML = '<tr><td colspan="8" class="skel">pricing unavailable</td></tr>'; return; }
    const px = Object.fromEntries(r.data.map((a) => [a.symbol, a]));
    let value = 0, cost = 0;
    pos.forEach((p, i) => {
      const a = px[p.sym], price = a?.price ?? null;
      const v = price != null ? price * p.qty : null;
      const c = p.cost * p.qty;
      const pnl = v != null ? v - c : null;
      const pnlPct = v != null && c > 0 ? (pnl / c) * 100 : null;
      if (v != null) { value += v; cost += c; }
      const tr = el('tr');
      const first = el('td');
      first.append(el('span', 'sym', p.sym));
      if (a) first.append(el('span', 'nm', a.name));
      tr.append(first);
      tr.append(el('td', 'num', String(p.qty)));
      tr.append(el('td', 'num', usd(p.cost)));
      tr.append(el('td', 'num', usd(price)));
      tr.append(el('td', 'num', usd(v)));
      tr.append(el('td', 'num ' + cls(pnl), pnl == null ? 'n/a' : (pnl >= 0 ? '+' : '-') + usd(Math.abs(pnl))));
      tr.append(el('td', 'num ' + cls(pnlPct), pct(pnlPct)));
      const td = el('td'), b = el('button', 'mini', 'remove');
      b.onclick = () => delPos(i);
      td.append(b); tr.append(td); tb.append(tr);
    });
    const pnl = value - cost;
    stat(dl, 'book value', usd(value));
    stat(dl, 'cost basis', usd(cost));
    stat(dl, 'unrealised', (pnl >= 0 ? '+' : '-') + usd(Math.abs(pnl)), cls(pnl));
    stat(dl, 'return', pct(cost > 0 ? (pnl / cost) * 100 : null), cls(pnl));
    stat(dl, 'positions', String(pos.length));
  } catch { tb.innerHTML = '<tr><td colspan="8" class="skel">offline</td></tr>'; }
}

/* =============================== alerts ============================= */

const getAlerts = () => store.get('alerts', []);
function addAlert(sym, dir, px) {
  const a = getAlerts();
  a.push({ sym: String(sym).toUpperCase(), dir, px: Number(px), fired: false });
  store.set('alerts', a); renderAlerts();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
function delAlert(i) { const a = getAlerts(); a.splice(i, 1); store.set('alerts', a); renderAlerts(); }

function renderAlerts() {
  const ul = $('#alert-list'); if (!ul) return;
  ul.textContent = '';
  const list = getAlerts();
  if (!list.length) { ul.append(el('li', 'skel', 'no alerts set')); return; }
  list.forEach((a, i) => {
    const li = el('li'); if (a.fired) li.classList.add('fired');
    li.append(el('span', 'sym', a.sym));
    li.append(el('span', null, `${a.dir} ${usd(a.px)}`));
    li.append(el('span', 'astate', a.fired ? 'triggered' : 'watching'));
    const b = el('button', 'mini', 'remove'); b.onclick = () => delAlert(i);
    li.append(b); ul.append(li);
  });
}

// Evaluated client side against quotes the watchlist already fetched, so alerts
// cost no extra API credits.
function checkAlerts(quotes) {
  const list = getAlerts(); if (!list.length) return;
  const px = Object.fromEntries(quotes.map((a) => [a.symbol, a.price]));
  let changed = false;
  for (const a of list) {
    const p = px[a.sym]; if (p == null) continue;
    const hit = a.dir === 'above' ? p > a.px : p < a.px;
    if (hit && !a.fired) {
      a.fired = true; changed = true;
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Signal Desk', { body: `${a.sym} ${a.dir} ${usd(a.px)}, now ${usd(p)}` });
      }
    } else if (!hit && a.fired) { a.fired = false; changed = true; }
  }
  if (changed) { store.set('alerts', list); renderAlerts(); }
}

/* ================================ rwa =============================== */
//
// Three tabs over two endpoint families. Assets and issuers come from the v5
// real world assets endpoints; sectors comes from categories, which aggregates
// in a way v5 does not.

let rwaLoaded = false;
let rwaTypeSel = '';

function rwaTab(name) {
  for (const t of ['assets', 'issuers', 'sectors']) {
    $('#rwatab-' + t).hidden = t !== name;
  }
  $$('[data-rwatab]').forEach((b) => {
    const on = b.dataset.rwatab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (name === 'issuers') loadIssuers();
  if (name === 'sectors') loadRwaSectors();
}

async function loadRwa() {
  if (rwaLoaded) return; rwaLoaded = true;
  $$('[data-rwatab]').forEach((b) => { b.onclick = () => rwaTab(b.dataset.rwatab); });
  await loadRwaTypes();
  await loadRwaAssets('');
}

async function loadRwaTypes() {
  const row = $('#rwa-types');
  row.textContent = '';
  let types = [];
  // Which types carry rows is asked of the API, never pinned here. Three are
  // populated today and the rest answer 200 with an empty list; a chip that
  // always opens an empty table is worse than no chip.
  try {
    const r = await fetch('api/rwa/types').then((x) => x.json());
    types = r.populated || [];
  } catch { /* fall through to the all chip alone */ }
  const mk = (val, label) => {
    const b = el('button', 'chip' + (val === rwaTypeSel ? ' on' : ''), label);
    b.onclick = () => {
      rwaTypeSel = val;
      $$('#rwa-types .chip').forEach((c) => c.classList.remove('on'));
      b.classList.add('on');
      loadRwaAssets(val);
    };
    row.append(b);
  };
  mk('', 'All');
  for (const t of types) mk(t, t.replace(/_/g, ' '));
}

async function loadRwaAssets(type) {
  const tb = $('#rwa-assets-table tbody');
  const note = $('#rwa-assets-note');
  tb.innerHTML = '<tr><td colspan="5" class="skel">loading</td></tr>';
  try {
    const r = await fetch('api/rwa/assets?limit=60' + (type ? '&type=' + encodeURIComponent(type) : '')).then((x) => x.json());
    tb.textContent = '';
    if (!r.ok || !r.data?.length) {
      tb.innerHTML = '<tr><td colspan="5" class="skel">' + (r.verdict === 'plan' ? 'this endpoint needs a paid plan' : 'no assets returned') + '</td></tr>';
      note.textContent = '';
      return;
    }
    for (const a of r.data) {
      const tr = el('tr');
      tr.tabIndex = 0;
      tr.className = 'rowopen';
      const open = () => openRwaAsset(a.id, a.symbol, a.name);
      tr.onclick = open;
      tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
      const c = el('td');
      c.append(el('strong', null, a.symbol || '?'));
      c.append(el('span', 'sub', a.name || ''));
      tr.append(c);
      tr.append(el('td', null, (a.type || '').replace(/_/g, ' ')));
      tr.append(el('td', 'num', usd(a.price)));
      tr.append(el('td', 'num', usd(a.tokenizedMarketCap)));
      tr.append(el('td', 'num', usd(a.tokenizedVolume24h)));
      tb.append(tr);
    }
    note.textContent = `${r.data.length} shown of ${r.total} tokenised assets indexed${type ? ' in ' + type.replace(/_/g, ' ') : ''}. Tap a row for the registrant behind the token.`;
  } catch {
    tb.innerHTML = '<tr><td colspan="5" class="skel">offline</td></tr>';
  }
}

// The detail that justifies the whole track: a tokenised equity resolved back to
// the company that issued the shares, including its SEC filing id.
async function openRwaAsset(id, symbol, name) {
  openModal(symbol || name || 'Asset', name || 'tokenised real world asset', (b) => {
    b.append(el('p', 'skel', 'loading'));
  });
  const body = $('#modal-body');
  try {
    const r = await fetch('api/rwa/asset/' + encodeURIComponent(id)).then((x) => x.json());
    if (!r.ok || !r.data) {
      body.textContent = '';
      body.append(el('p', 'skel', 'no metadata returned for this asset'));
      return;
    }
    const a = r.data;
    const cells = [
      ['Tokenised price', usd(a.price)],
      ['Tokenised cap', usd(a.tokenizedMarketCap)],
      ['Tokenised volume', usd(a.tokenizedVolume24h)],
      ['Type', (a.type || 'n/a').replace(/_/g, ' ')],
      ['Rank', a.rank == null ? 'n/a' : '#' + a.rank],
      ['Industry', a.industry || 'n/a'],
      ['Founded', a.founded || 'n/a'],
      ['Employees', a.employees ? Number(a.employees).toLocaleString() : 'n/a'],
      ['SEC CIK', a.cik || 'n/a'],
    ];
    const wrap = el('div');
    const grid = el('div', 'mgrid');
    for (const [k, v] of cells) {
      const cell = el('div', 'mcell');
      cell.append(el('span', 'mk', k));
      cell.append(el('span', 'mv', v));
      grid.append(cell);
    }
    wrap.append(grid);

    // One real world asset maps to many tokens, each minted by a named issuer.
    if (r.tokens?.length) {
      wrap.append(el('h4', 'msub', `Tokens representing this asset (${r.tokens.length})`));
      const list = el('div', 'tokline');
      for (const t of r.tokens.slice(0, 8)) {
        const row = el('div', 'tokrow');
        const left = el('div');
        left.append(el('strong', null, t.symbol || '?'));
        left.append(el('span', 'sub', t.issuer ? 'by ' + t.issuer : (t.name || '')));
        row.append(left);
        const right = el('div', 'tokright');
        right.append(el('span', 'mv', usd(t.price)));
        right.append(el('span', 'sub', usd(t.marketCap)));
        row.append(right);
        list.append(row);
      }
      wrap.append(list);
    }

    if (a.about) wrap.append(el('p', 'mabout', a.about));
    if (a.website) {
      const link = el('a', 'mlink', a.website.replace(/^https?:\/\//, ''));
      link.href = a.website; link.target = '_blank'; link.rel = 'noopener noreferrer';
      wrap.append(link);
    }
    if (r.marketPairsVerdict === 'plan') {
      wrap.append(el('p', 'hint', 'Market pairs for this asset are the one v5 endpoint the free plan refuses. Everything above is on the free tier.'));
    }
    $('#modal-title').textContent = a.symbol || symbol || 'Asset';
    $('#modal-sub').textContent = [a.name, a.type && a.type.replace(/_/g, ' ')].filter(Boolean).join(', ');
    body.textContent = '';
    body.append(wrap);
  } catch {
    body.textContent = '';
    body.append(el('p', 'skel', 'offline'));
  }
}

let issuersLoaded = false;
async function loadIssuers() {
  if (issuersLoaded) return; issuersLoaded = true;
  const grid = $('#rwa-issuers');
  grid.innerHTML = '<p class="skel">loading</p>';
  try {
    const r = await fetch('api/rwa/issuers').then((x) => x.json());
    grid.textContent = '';
    if (!r.ok || !r.data?.length) { grid.append(el('p', 'skel', 'no issuers returned')); return; }
    const ordered = [...r.data].sort((a, c) => (c.tokens || 0) - (a.tokens || 0));
    for (const i of ordered) {
      const b = el('button', 'isscard');
      if (i.logo) {
        const img = el('img', 'isslogo');
        img.src = i.logo; img.alt = ''; img.loading = 'lazy';
        img.onerror = () => img.remove();
        b.append(img);
      }
      const t = el('div', 'isstext');
      t.append(el('strong', null, i.name));
      // A registered issuer with nothing indexed is a real state, not an error.
      // Saying "0 tokenised" reads like a failed load, so it says what it means.
      t.append(el('span', 'sub', i.tokens ? i.tokens + ' tokenised' : 'registered, none indexed yet'));
      if (!i.tokens) b.classList.add('empty');
      b.append(t);
      b.onclick = () => {
        $$('.isscard').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        loadIssuer(i.id, i.name);
      };
      grid.append(b);
    }
  } catch { grid.textContent = ''; grid.append(el('p', 'skel', 'offline')); }
}

async function loadIssuer(id, name) {
  const box = $('#rwa-issuer-detail'), t = $('#rwa-issuer-title'), tb = $('#rwa-issuer-table tbody');
  box.hidden = false;
  t.textContent = name + ', loading';
  tb.innerHTML = '<tr><td colspan="4" class="skel">loading</td></tr>';
  try {
    const r = await fetch('api/rwa/issuer/' + encodeURIComponent(id)).then((x) => x.json());
    tb.textContent = '';
    if (!r.ok || !r.tokens?.length) {
      t.textContent = name;
      const why = r.ok
        ? `CoinMarketCap lists ${name} as an issuer but indexes no tokens for it yet. Registered to tokenise, nothing live.`
        : 'that issuer could not be loaded';
      tb.innerHTML = '';
      const tr = el('tr'), td = el('td', 'skel', why);
      td.colSpan = 3; tr.append(td); tb.append(tr);
      return;
    }
    const shown = r.tokens.slice(0, 60);
    t.textContent = `${name}, ${shown.length} of ${r.data.tokens} tokens`;
    for (const k of shown) {
      const tr = el('tr');
      tr.append(el('td', null, k.name || ''));
      tr.append(el('td', null, k.symbol || ''));
      tr.append(el('td', 'num', k.rwaId == null ? 'n/a' : String(k.rwaId)));
      // The rwa_id is the join back to the asset, so an issuer row opens the
      // asset it minted rather than being a dead end.
      if (k.rwaId != null) {
        tr.tabIndex = 0;
        tr.className = 'rowopen';
        const open = () => openRwaAsset(k.rwaId, k.symbol, k.name);
        tr.onclick = open;
        tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
      }
      tb.append(tr);
    }
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch {
    t.textContent = name;
    tb.innerHTML = '<tr><td colspan="3" class="skel">offline</td></tr>';
  }
}

let rwaSectorsLoaded = false;
async function loadRwaSectors() {
  if (rwaSectorsLoaded) return; rwaSectorsLoaded = true;
  const grid = $('#rwa-grid'); grid.innerHTML = '<p class="skel">loading</p>';
  try {
    const r = await fetch('api/rwa/sectors').then((x) => x.json());
    grid.textContent = '';
    if (!r.ok || !r.data.length) { grid.append(el('p', 'skel', 'categories unavailable')); return; }
    for (const c of r.data) {
      const b = el('button', 'rwacard');
      b.append(el('h3', null, c.label));
      const m = el('div', 'rmeta');
      m.append(el('span', null, c.tokens + ' tokens'));
      m.append(el('span', cls(c.change24h), pct(c.change24h)));
      b.append(m);
      const m2 = el('div', 'rmeta'); m2.append(el('span', null, usd(c.marketCap)));
      b.append(m2);
      b.onclick = () => { $$('.rwacard').forEach((x) => x.classList.remove('on')); b.classList.add('on'); loadRwaCat(c.id, c.label); };
      grid.append(b);
    }
  } catch { grid.textContent = ''; grid.append(el('p', 'skel', 'offline')); }
}

async function loadRwaCat(id, label) {
  const t = $('#rwa-title'), tbl = $('#rwa-table'), tb = $('#rwa-table tbody');
  t.hidden = false; t.textContent = label + ', loading';
  tbl.hidden = false; tb.textContent = '';
  try {
    const r = await fetch('api/rwa/sector/' + encodeURIComponent(id)).then((x) => x.json());
    if (!r.ok || !r.data?.length) { t.textContent = label; tb.innerHTML = '<tr><td colspan="5" class="skel">no constituents returned</td></tr>'; return; }
    t.textContent = `${label}, ${r.data.length} constituents by market cap`;
    for (const a of r.data) {
      const tr = el('tr');
      makeRowOpen(tr, a.symbol);
      tr.append(assetCell(a));
      tr.append(el('td', 'num', usd(a.price)));
      tr.append(el('td', 'num ' + cls(a.change24h), pct(a.change24h)));
      tr.append(el('td', 'num ' + cls(a.change7d), pct(a.change7d)));
      tr.append(el('td', 'num', usd(a.marketCap)));
      tb.append(tr);
    }
  } catch { t.textContent = label; tb.innerHTML = '<tr><td colspan="5" class="skel">offline</td></tr>'; }
}

/* ============================== chains ============================== */

let chainsLoaded = false;
async function loadChains() {
  if (chainsLoaded) return; chainsLoaded = true;
  try {
    const r = await fetch('api/chains').then((x) => x.json());
    CHAINS = r.data || [];
    $('#chain-total').textContent = `${r.total} networks indexed by CoinMarketCap`;
    renderChainTable('');
  } catch { $('#chain-total').textContent = 'network list unavailable'; }
}

function renderChainTable(q) {
  const tb = $('#chain-table tbody'); if (!tb) return;
  tb.textContent = '';
  const rows = (q ? CHAINS.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())) : CHAINS).slice(0, 80);
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="3" class="skel">no match</td></tr>'; return; }
  for (const c of rows) {
    const tr = el('tr');
    tr.append(el('td', null, c.name));
    tr.append(el('td', 'num', String(c.id)));
    tr.append(el('td', 'num', c.chainId == null ? 'n/a' : String(c.chainId)));
    tb.append(tr);
  }
}

function renderHighlightChains(c) {
  const ul = $('#chain-list'); if (!ul) return;
  ul.textContent = '';
  if (!c || !c.highlighted || !c.highlighted.length) { ul.append(el('li', 'skel', 'platform list unavailable')); return; }
  for (const h of c.highlighted) {
    const li = el('li');
    li.append(el('span', 'cname', h.name));
    li.append(el('span', 'cid', 'id ' + h.id));
    ul.append(li);
  }
}

/* ================================ 3D ================================ */

let threeReady = false;
let threeRefresh = null;   // set once the scene exists, re-renders on re-entry

function initThree() {
  try { buildThree(); }
  catch (e) {
    // WebGL is not guaranteed: old devices, blocked contexts and headless
    // browsers all fail here. The table below carries the same data, so this
    // degrades to a note rather than a thrown exception that stops the page.
    threeReady = true;
    const wrap = $('#three-wrap');
    if (wrap && !wrap.dataset.failed) {
      wrap.dataset.failed = '1';
      wrap.innerHTML = '';
      const p = el('p', 'skel', 'This browser could not open a WebGL context, so the 3D view is unavailable. The table below carries the same figures.');
      p.style.cssText = 'padding:22px;max-width:52ch';
      wrap.append(p);
    }
  }
}

function buildThree() {
  if (threeReady || typeof THREE === 'undefined') return;
  const wrap = $('#three-wrap');
  if (!wrap || !SIGNAL || !SIGNAL.rotation || !SIGNAL.rotation.length) return;
  threeReady = true;

  const W = wrap.clientWidth, H = wrap.clientHeight;
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0f1116, 26, 62);
  const cam = new THREE.PerspectiveCamera(46, W / H, 0.1, 200);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(W, H);
  wrap.append(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.62));
  const key = new THREE.DirectionalLight(0xffd9b0, 1.15); key.position.set(9, 16, 8); scene.add(key);
  const rim = new THREE.DirectionalLight(0x3d7bff, 0.55); rim.position.set(-10, 7, -8); scene.add(rim);

  const rows = SIGNAL.rotation.slice(0, 12);
  const caps = rows.map((r) => Math.max(1, r.marketCap));
  const lo = Math.log10(Math.min.apply(null, caps)), hi = Math.log10(Math.max.apply(null, caps));
  const cols = 4, gap = 3.1, bars = [];

  rows.forEach((r, i) => {
    const x = (i % cols - (cols - 1) / 2) * gap;
    const z = (Math.floor(i / cols) - 1) * gap;
    // log scale, because sector caps span several orders of magnitude and a
    // linear axis would render everything but the largest as a flat sheet
    const norm = hi > lo ? (Math.log10(caps[i]) - lo) / (hi - lo) : 0.5;
    const h = 0.6 + norm * 8;
    const col = new THREE.Color(r.change24h > 0 ? 0x22c55e : 0xef4444);
    col.lerp(new THREE.Color(0xf97316), 0.34);
    const mat = new THREE.MeshStandardMaterial({
      color: col, roughness: 0.44, metalness: 0.22, emissive: col.clone().multiplyScalar(0.16),
    });
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.7, h, 1.7), mat);
    bar.position.set(x, h / 2, z);
    bar.userData = { row: r, target: h };
    if (!REDUCED) { bar.scale.y = 0.001; bar.position.y = 0.001; }
    scene.add(bar); bars.push(bar);
  });

  scene.add(new THREE.GridHelper(26, 13, 0x2e323d, 0x1b1e26));

  // orbit written by hand rather than pulling OrbitControls for six lines
  let ax = 0.62, ay = 0.72, dist = 24, drag = false, px = 0, py = 0;
  const place = () => {
    cam.position.set(Math.sin(ay) * Math.cos(ax) * dist, Math.sin(ax) * dist, Math.cos(ay) * Math.cos(ax) * dist);
    cam.lookAt(0, 2, 0);
  };
  place();

  const dom = renderer.domElement;
  const ray = new THREE.Raycaster(), pt = new THREE.Vector2(), tip = $('#three-tip');

  function hover(e) {
    const b = dom.getBoundingClientRect();
    pt.x = ((e.clientX - b.left) / b.width) * 2 - 1;
    pt.y = -((e.clientY - b.top) / b.height) * 2 + 1;
    ray.setFromCamera(pt, cam);
    const hit = ray.intersectObjects(bars)[0];
    if (!hit) { tip.hidden = true; return; }
    const r = hit.object.userData.row;
    tip.innerHTML = `<b>${r.name}</b>${usd(r.marketCap)} &nbsp; <span class="${cls(r.change24h)}">${pct(r.change24h)}</span> &nbsp; ${r.tokens} tokens`;
    tip.style.left = (e.clientX - b.left) + 'px';
    tip.style.top = (e.clientY - b.top) + 'px';
    tip.hidden = false;
  }

  dom.addEventListener('pointerdown', (e) => { drag = true; px = e.clientX; py = e.clientY; dom.setPointerCapture(e.pointerId); });
  dom.addEventListener('pointerup', (e) => { drag = false; try { dom.releasePointerCapture(e.pointerId); } catch {} });
  dom.addEventListener('pointerleave', () => { tip.hidden = true; });
  dom.addEventListener('pointermove', (e) => {
    if (drag) {
      ay -= (e.clientX - px) * 0.008;
      ax = Math.max(0.12, Math.min(1.35, ax + (e.clientY - py) * 0.006));
      px = e.clientX; py = e.clientY; place();
      const hint = $('#three-hint'); if (hint) hint.style.opacity = '0';
    }
    hover(e);
  });
  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    dist = Math.max(12, Math.min(44, dist + Math.sign(e.deltaY) * 1.6));
    place();
  }, { passive: false });

  // Touch: one finger orbits, two fingers pinch to zoom. Without this the only
  // way to zoom on a phone would be the page zoom, which fights the layout.
  let pinch = 0;
  const span = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  dom.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { pinch = span(e.touches); }
  }, { passive: true });
  dom.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinch) {
      e.preventDefault();
      const d = span(e.touches);
      dist = Math.max(12, Math.min(44, dist * (pinch / d)));
      pinch = d; place();
    }
  }, { passive: false });
  dom.addEventListener('touchend', () => { pinch = 0; });

  const t0 = performance.now();
  (function loop(t) {
    requestAnimationFrame(loop);
    if (!REDUCED) {
      const k = Math.min(1, (t - t0) / 1100), e = 1 - Math.pow(1 - k, 3);
      bars.forEach((b, i) => {
        const d = Math.min(1, Math.max(0, e * 1.4 - i * 0.045));
        b.scale.y = Math.max(0.001, d);
        b.position.y = (b.userData.target * d) / 2;
      });
      if (!drag) { ay += 0.0009; place(); }
    }
    renderer.render(scene, cam);
  })(performance.now());

  const resize = () => {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    cam.aspect = w / h; cam.updateProjectionMatrix(); renderer.setSize(w, h);
    renderer.render(scene, cam);
  };
  addEventListener('resize', resize);
  threeRefresh = resize;

  // A lost context stops rendering silently. Say so instead of showing a blank box.
  dom.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    wrap.dataset.failed = '1';
    wrap.innerHTML = '<p class="skel" style="padding:22px;max-width:52ch">The graphics context was lost, so the 3D view stopped. The table below carries the same figures.</p>';
  });
}

/* ============================ rotation table ======================== */

function renderRotation(rows) {
  const tb = $('#rotation-table tbody'); if (!tb) return;
  tb.textContent = '';
  if (!rows || !rows.length) { tb.innerHTML = '<tr><td colspan="4" class="skel">categories unavailable</td></tr>'; return; }
  for (const r of rows) {
    const tr = el('tr');
    tr.append(el('td', null, r.name));
    tr.append(el('td', 'num', String(r.tokens)));
    tr.append(el('td', 'num', usd(r.marketCap)));
    tr.append(el('td', 'num ' + cls(r.change24h), pct(r.change24h)));
    tb.append(tr);
  }
}

/* ============================ capability ============================ */

function renderCapability(cap) {
  const ul = $('#cap-list'); if (!ul) return;
  ul.textContent = '';
  if (!cap || !cap.checks) { ul.append(el('li', 'skel', 'probe failed')); return; }
  for (const c of cap.checks) {
    const li = el('li');
    const tone = c.verdict === 'ok' ? 'ok' : c.verdict === 'plan' ? 'plan' : c.verdict === 'skipped' ? 'plan' : 'bad';
    li.append(el('span', 'dot ' + tone));
    li.append(el('span', 'ep', c.method + ' ' + c.path));
    const label = c.verdict === 'ok' ? 'reachable'
      : c.verdict === 'plan' ? 'needs a paid plan'
      : c.verdict === 'skipped' ? 'not probed' : c.verdict;
    li.append(el('span', 'vd', label));
    ul.append(li);
  }
  const gated = (cap.gated && cap.gated.length) || 0;
  const p = $('#pill-plan');
  p.textContent = gated ? gated + ' endpoints need a paid plan' : 'all endpoints reachable';
  p.className = 'pill ' + (gated ? 'warn' : 'good');
  const dl = $('#usage-stats');
  if (dl && cap.usage) {
    dl.textContent = '';
    stat(dl, 'calls this session', String(cap.usage.calls));
    stat(dl, 'credits spent', String(cap.usage.creditsUsed));
    stat(dl, 'endpoints reachable', String((cap.usable && cap.usable.length) || 0), 'up');
    stat(dl, 'refused by plan', String(gated), gated ? 'dn' : '');
    stat(dl, 'key', cap.usage.hasKey ? 'present' : 'missing', cap.usage.hasKey ? 'up' : 'dn');
  }
}

/* ============================== boot ================================ */

async function load() {
  try {
    const r = await fetch('api/signal').then((x) => x.json());
    if (!r.ok) throw new Error(r.error || 'signal failed');
    SIGNAL = r;
    renderRegime(r.regime);
    renderBreadth(r.breadth);
    renderDivergence(r.regime, r.breadth);
    renderHighlightChains(r.chains);
    renderRotation(r.rotation);

    // The screener reuses the single listings call already made for breadth.
    const g = (r.movers && r.movers.gainers) || [], l = (r.movers && r.movers.losers) || [];
    LISTINGS = [...g, ...l].filter((v, i, a) => a.findIndex((x) => x.symbol === v.symbol) === i);
    renderScreen();
    renderTape(LISTINGS);

    $('#pill-clock').textContent = 'updated ' + new Date(r.at).toUTCString().slice(17, 25) + ' UTC';
    if (r.usage) $('#foot-usage').textContent = `${r.usage.calls} calls, ${r.usage.creditsUsed} credits, key ${r.usage.hasKey ? 'present' : 'missing'}`;
  } catch (e) {
    $('#regime-stance').textContent = 'offline';
    $('#regime-why').textContent = String(e.message);
  }
  try { renderCapability(await fetch('api/capability').then((x) => x.json())); } catch { renderCapability(null); }
  loadWatch();

  // The 3D view needs SIGNAL, which arrives after the first paint. Someone who
  // deep links to #rotation triggers initThree before the data exists, so it
  // returns early and nothing retries. Build it once the data is actually here.
  if (location.hash.slice(1) === 'rotation') initThree();
}

$('#watch-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#watch-input').value.trim();
  if (!v) return;
  addWatch(v); toast(v.toUpperCase() + ' added to your watchlist');
  $('#watch-input').value = '';
});
$('#chain-search').addEventListener('input', (e) => renderChainTable(e.target.value));
['#f-q', '#f-min', '#f-max', '#f-vol', '#f-sort'].forEach((s) => $(s).addEventListener('input', renderScreen));
$('#f-reset').addEventListener('click', () => {
  ['#f-q', '#f-min', '#f-max', '#f-vol'].forEach((s) => { $(s).value = ''; });
  $('#f-sort').value = 'marketCap'; renderScreen();
});
$('#pos-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = $('#pos-sym').value, q = $('#pos-qty').value, c = $('#pos-cost').value;
  if (!s || !q || !c) return;
  addPos(s, q, c); toast(String(s).toUpperCase() + ' added to your book');
  $('#pos-sym').value = ''; $('#pos-qty').value = ''; $('#pos-cost').value = '';
});
$('#alert-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = $('#al-sym').value, d = $('#al-dir').value, p = $('#al-px').value;
  if (!s || !p) return;
  addAlert(s, d, p); toast('Alert set on ' + String(s).toUpperCase());
  $('#al-sym').value = ''; $('#al-px').value = '';
});

$('#more-btn').addEventListener('click', () => {
  const sh = $('#more-sheet');
  if (sh.hidden) openSheet(); else closeSheet();
});
$('#sheet-backdrop').addEventListener('click', closeSheet);
$('#modal-x').addEventListener('click', closeModal);
$('#modal-backdrop').addEventListener('click', closeModal);
addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeSheet(); } });

// Swipe the sheet style modal down to dismiss, as a phone user expects.
(() => {
  const m = $('#modal'); let y0 = null;
  m.addEventListener('touchstart', (e) => { if (m.scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
  m.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy > 0) m.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  m.addEventListener('touchend', (e) => {
    if (y0 == null) return;
    const dy = (e.changedTouches[0].clientY - y0);
    m.style.transform = '';
    if (dy > 90) closeModal();
    y0 = null;
  });
})();

// The ambient video is decorative, so it is only fetched when motion is welcome.
if (!REDUCED) {
  const v = $('#bgvid');
  if (v) { v.src = 'img/ambient.mp4'; v.play().catch(() => {}); }
}

show(location.hash.slice(1) || 'desk');
load();
setInterval(load, 5 * 60 * 1000);
