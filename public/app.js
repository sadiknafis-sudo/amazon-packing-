'use strict';

// ---------------------------------------------------------------------------
// State + live sync
// ---------------------------------------------------------------------------
let S = null; // shared state from the server
const ui = {
  view: localStorage.getItem('view') || 'pack',
  packer: localStorage.getItem('packer') === null ? null : Number(localStorage.getItem('packer')),
  stockFilter: 'todo',
  stockQuery: '',
  stockWalk: false,
  orderFilter: 'all',
  photoFilter: 'none',
  claiming: false,
  helping: false, // this packer finished their share and is helping the other
  suggestions: null,
  photoLog: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => $('#conn').classList.add('ok');
  es.onmessage = (e) => {
    S = JSON.parse(e.data);
    render();
  };
  es.onerror = () => $('#conn').classList.remove('ok'); // EventSource reconnects on its own
}

async function act(action) {
  try {
    const r = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packer: ui.packer, ...action }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Failed');
  } catch (e) {
    toast(e.message || 'No connection to the server');
  }
}

function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function flash(good) {
  const f = $('#flash');
  f.hidden = true;
  f.className = good ? 'g' : 'r';
  f.textContent = good ? '✓' : '✗';
  void f.offsetWidth; // restart animation
  f.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => (f.hidden = true), 460);
  if (navigator.vibrate) navigator.vibrate(good ? 40 : [60, 60, 60]);
}

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------
const day = () => S.day;
const packerName = (i) => (i == null ? '—' : S.packers[i] || `Packer ${i + 1}`);
const isOpen = (o) => o.lines.some((l) => !l.status);
const img = (key) => S.images[key];

function orderStatus(o) {
  if (o.lines.every((l) => l.status === 'packed')) return 'packed';
  if (!isOpen(o)) return 'missing';
  if (o.claimedBy != null || o.lines.some((l) => l.status)) return 'working';
  return 'open';
}

// The day's product list: the Total Items Pick List if imported, otherwise
// added up from the packing sheets.
function totals() {
  if (day().totals.length) return day().totals;
  const map = new Map();
  for (const o of day().orders)
    for (const l of o.lines) {
      const t = map.get(l.key) || { key: l.key, name: l.name, qty: 0 };
      t.qty += l.qty;
      map.set(l.key, t);
    }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function allProducts() {
  const map = new Map();
  for (const t of totals()) map.set(t.key, t.name);
  for (const o of day().orders) for (const l of o.lines) if (!map.has(l.key)) map.set(l.key, l.name);
  return [...map].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
}

// What the purchasers need to get the shoppers to buy.
function shoppingList() {
  const out = new Map();
  const tot = new Map(totals().map((t) => [t.key, t]));
  for (const [key, s] of Object.entries(day().stock)) {
    if (s.status !== 'missing' && s.status !== 'bought') continue;
    const t = tot.get(key);
    out.set(key, {
      key,
      name: t ? t.name : key,
      qty: s.need || (t ? t.qty : 1),
      status: s.status,
      from: 'Morning stock check',
      orders: [],
    });
  }
  for (const o of day().orders)
    for (const l of o.lines) {
      if (l.status !== 'missing') continue;
      const s = day().stock[l.key];
      let e = out.get(l.key);
      if (!e) {
        // Ran out while packing, not caught in the morning.
        const bought = s && s.status === 'bought' && s.at > l.at;
        e = { key: l.key, name: l.name, qty: 0, status: bought ? 'bought' : 'missing', from: 'Found missing while packing', orders: [], packing: true };
        out.set(l.key, e);
      }
      if (e.packing) e.qty += l.qty;
      e.orders.push(o.ref);
    }
  return [...out.values()].sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'missing' ? -1 : 1));
}

function packStats() {
  const s = { orders: 0, done: 0, waiting: 0, lines: 0, packed: 0, missing: 0, units: 0, unitsPacked: 0, per: [0, 1].map(() => ({ packed: 0, missing: 0, orders: 0 })) };
  for (const o of day().orders) {
    s.orders++;
    const st = orderStatus(o);
    if (st === 'packed') s.done++;
    if (st === 'missing') s.waiting++;
    const finisher = o.lines.reduce((a, l) => (l.at && (!a || l.at > a.at) ? l : a), null);
    if (!isOpen(o) && finisher && s.per[finisher.by]) s.per[finisher.by].orders++;
    for (const l of o.lines) {
      s.lines++;
      s.units += l.qty;
      if (l.status === 'packed') {
        s.packed++;
        s.unitsPacked += l.qty;
      }
      if (l.status === 'missing') s.missing++;
      if (l.status && s.per[l.by]) s.per[l.by][l.status]++;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function picHTML(key, name, { camera = true, showName = true } = {}) {
  const src = img(key);
  const inner = src
    ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'Photo failed to load'}))">`
    : `<div class="noimg"><div>📷</div>${showName ? `<div>${esc(name)}</div>` : ''}<div class="muted" style="font-size:15px;font-weight:600">No photo yet</div></div>`;
  const cam = camera ? `<button class="camera" data-photo="${esc(key)}" data-name="${esc(name)}">📷 ${src ? 'Change' : 'Add photo'}</button>` : '';
  return inner + cam;
}

function sourceTag(key) {
  const m = S.imageMeta?.[key];
  if (!img(key) || !m || !m.source || m.source === 'Photo') return '';
  return `<span class="src-tag" title="${esc(m.title)}">${esc(m.source)} listing photo</span>`;
}

function bar(g, r, total) {
  const pg = total ? (g / total) * 100 : 0;
  const pr = total ? (r / total) * 100 : 0;
  return `<div class="bar"><i class="g" style="width:${pg}%"></i><i class="r" style="width:${pr}%"></i></div>`;
}

function render() {
  if (!S) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === ui.view));
  const need = shoppingList().filter((x) => x.status === 'missing').length;
  const badge = $('#shopBadge');
  badge.hidden = !need;
  badge.textContent = need;
  const v = $('#view');
  const scroll = v.scrollTop;
  v.innerHTML = { pack: viewPack, stock: viewStock, shop: viewShop, summary: viewSummary, setup: viewSetup }[ui.view]();
  v.scrollTop = scroll;
}

function noData() {
  return `<div class="page"><div class="card empty"><div class="big">📄</div><h1>No lists loaded for today</h1>
    <p class="muted">Go to <b>Setup</b> and import today's <b>Packing Sheet</b> and <b>Total Items Pick List</b> PDFs.</p>
    <button class="btn primary" data-go="setup">Go to Setup</button></div></div>`;
}

// ---------------------------------------------------------------------------
// Pack view
// ---------------------------------------------------------------------------
function viewPack() {
  if (ui.packer == null || ui.packer > 1) {
    return `<div class="page"><h1>Who is packing on this device?</h1>
      <div class="pick-packer">${[0, 1].map((i) => `<button data-packer="${i}">${esc(packerName(i))}<small>Tap to start</small></button>`).join('')}</div></div>`;
  }
  if (!day().orders.length) return noData();

  const me = ui.packer;
  const order = day().orders.find((o) => o.claimedBy === me && isOpen(o));
  const st = packStats();

  if (!order) {
    const claimable = (o) => o.claimedBy == null && isOpen(o) && (o.assigned == null || o.assigned === me || ui.helping);
    if (day().orders.some(claimable)) {
      if (!ui.claiming) {
        ui.claiming = true;
        act({ type: 'claim', help: ui.helping }).finally(() => (ui.claiming = false));
      }
      return `<div class="page empty"><div class="big">⏳</div><h1>Getting next order…</h1></div>`;
    }
    const othersLeft = day().orders.filter((o) => o.claimedBy == null && isOpen(o) && o.assigned === 1 - me).length;
    if (othersLeft) {
      return `<div class="page"><div class="card empty"><div class="big">💪</div>
        <h1>Your orders are done!</h1>
        <p class="muted">${esc(packerName(1 - me))} still has ${othersLeft} order(s) not started.</p>
        <p><button class="btn green" data-help style="font-size:22px;padding:18px 28px">Help ${esc(packerName(1 - me))}</button></p>
        <p class="muted" style="font-size:14px">You'll take their orders from the end of the list, so you won't bump into each other.</p>
        <p><button class="btn" data-go="summary">See summary</button> <button class="btn" data-switch>Switch packer</button></p>
      </div></div>`;
    }
    const other = day().orders.filter((o) => o.claimedBy != null && o.claimedBy !== me && isOpen(o)).length;
    const boughtWaiting = shoppingList().filter((x) => x.status === 'bought' && x.orders.length);
    return `<div class="page"><div class="card empty">
      <div class="big">${st.waiting ? '🟥' : '🎉'}</div>
      <h1>${st.waiting ? 'Nothing left to pack right now' : 'All orders packed!'}</h1>
      <p class="muted">${st.done} of ${st.orders} orders fully packed · ${st.waiting} waiting for missing items${other ? ` · ${packerName(1 - me)} is finishing ${other}` : ''}</p>
      ${boughtWaiting.length ? `<div class="banner info">🛒 Shoppers brought ${boughtWaiting.length} missing item(s) — ${boughtWaiting.reduce((a, x) => a + x.orders.length, 0)} order(s) can be finished now.</div><p><button class="btn blue" data-act="reopenBought">Pack those orders now</button></p>` : ''}
      <p><button class="btn" data-go="summary">See summary</button> <button class="btn" data-switch>Switch packer</button></p>
    </div></div>`;
  }

  const idx = order.lines.findIndex((l) => !l.status);
  const line = order.lines[idx];
  const stock = day().stock[line.key];
  const nextLine = order.lines.slice(idx + 1).find((l) => !l.status);
  const banners = [];
  if (stock && stock.status === 'missing') banners.push(`<div class="banner warn">⚠ Marked NOT IN STOCK this morning — shoppers are buying it. Check before marking missing.</div>`);
  if (stock && stock.status === 'bought') banners.push(`<div class="banner info">🛒 Shoppers bought this item — it should be in the warehouse now.</div>`);
  if (order.lines.length > 1) banners.push(`<div class="banner amber">📦 This order has ${order.lines.length} different items — same box!</div>`);

  return `<div class="pack">
    <div class="pack-top">
      <button class="who" data-switch>👤 ${esc(packerName(me))} ▾</button>
      ${order.assigned != null && order.assigned !== me ? `<span class="status-tag working">Helping ${esc(packerName(order.assigned))}</span>` : ''}
      <div><div class="order-ref">${esc(order.ref)}</div><div class="order-to">${esc(order.recipient)}</div></div>
      ${order.lines.length > 1 ? `<div><div class="muted" style="font-size:14px">Item ${idx + 1} of ${order.lines.length}</div><div class="dots">${order.lines.map((l, i) => `<span class="dot ${l.status || (i === idx ? 'cur' : '')}"></span>`).join('')}</div></div>` : ''}
      <div class="spacer"></div>
      <div class="progress"><div class="muted" style="font-size:14px">${st.done + st.waiting} / ${st.orders} orders done</div>${bar(st.done, st.waiting, st.orders)}</div>
    </div>
    <div class="banner-wrap">${banners.join('')}</div>
    <div class="pic" data-mark="packed" data-id="${esc(line.id)}">${picHTML(line.key, line.name)}${sourceTag(line.key)}<span class="tap-hint">Tap photo = packed ✓</span></div>
    <div class="pack-side">
      <div class="pack-info">
        <div class="pack-name">${esc(line.name)}</div>
        <div class="qty ${line.qty > 1 ? 'multi' : ''}"><small>QTY</small><b>${line.qty}</b></div>
      </div>
      ${nextLine ? `<div class="next">Next in this order: ${esc(nextLine.name)} × ${nextLine.qty}</div>` : ''}
      <div class="pack-actions">
        <button class="b-undo" data-act="undo">↶ Back</button>
        <button class="b-miss" data-mark="missing" data-id="${esc(line.id)}">✗ Don't have</button>
        <button class="b-ok" data-mark="packed" data-id="${esc(line.id)}">✓ Packed</button>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Stock check view (morning)
// ---------------------------------------------------------------------------
function viewStock() {
  const list = totals();
  if (!list.length) return noData();
  const stock = day().stock;
  const counts = { todo: 0, have: 0, missing: 0, bought: 0 };
  for (const t of list) counts[stock[t.key]?.status || 'todo']++;

  if (ui.stockWalk) {
    const t = list.find((x) => !stock[x.key]);
    if (!t) ui.stockWalk = false;
    else {
      const done = list.length - counts.todo;
      return `<div class="pack">
        <div class="pack-top">
          <button class="who" data-walk="0">✕ Exit</button>
          <div><div class="order-ref" style="font-size:26px">Morning stock check</div><div class="order-to">${done + 1} of ${list.length}</div></div>
          <div class="spacer"></div>
          <div class="progress"><div class="muted" style="font-size:14px">${counts.have} have · ${counts.missing} missing</div>${bar(counts.have + counts.bought, counts.missing, list.length)}</div>
        </div>
        <div class="banner-wrap"></div>
        <div class="pic" data-stock="have" data-key="${esc(t.key)}">${picHTML(t.key, t.name)}<span class="tap-hint">Tap photo = we have it ✓</span></div>
        <div class="pack-side">
          <div class="pack-info">
            <div class="pack-name">${esc(t.name)}</div>
            <div class="qty ${t.qty > 1 ? 'multi' : ''}"><small>NEED</small><b>${t.qty}</b></div>
          </div>
          <div class="pack-actions">
            <button class="b-undo" data-stock-undo>↶ Back</button>
            <button class="b-miss" data-stock="missing" data-key="${esc(t.key)}">✗ Don't have</button>
            <button class="b-ok" data-stock="have" data-key="${esc(t.key)}">✓ We have it</button>
          </div>
        </div>
      </div>`;
    }
  }

  const q = ui.stockQuery.toLowerCase();
  const shown = list.filter((t) => (ui.stockFilter === 'all' || (stock[t.key]?.status || 'todo') === ui.stockFilter) && (!q || t.name.toLowerCase().includes(q)));
  const chip = (f, label) => `<button class="chip ${ui.stockFilter === f ? 'on' : ''}" data-sfilter="${f}">${label}</button>`;

  return `<div class="page">
    <div class="row"><h1>Morning stock check</h1><div class="spacer"></div>
      ${counts.todo ? `<button class="btn primary" data-walk="1">▶ Go through one by one (${counts.todo} left)</button>` : ''}</div>
    <p class="muted" style="margin-top:0">Go through today's total list. Green = we have it in the warehouse. Red = we don't — it goes on the <b>Shopping list</b> for the purchasers.</p>
    <div class="stats">
      <div class="stat"><b>${counts.todo}</b>Not checked</div>
      <div class="stat g"><b>${counts.have}</b>In warehouse</div>
      <div class="stat r"><b>${counts.missing}</b>Missing</div>
      <div class="stat"><b style="color:var(--blue)">${counts.bought}</b>Bought by shoppers</div>
    </div>
    <div class="row" style="margin-top:12px">
      <div class="chips" style="margin:0">${chip('todo', 'Not checked')}${chip('missing', 'Missing')}${chip('have', 'Have')}${chip('bought', 'Bought')}${chip('all', 'All')}</div>
      <input class="search" id="stockSearch" placeholder="Search products…" value="${esc(ui.stockQuery)}">
    </div>
    <div class="grid" style="margin-top:12px">
      ${shown.map((t) => stockTile(t, stock[t.key])).join('') || `<div class="muted">Nothing here.</div>`}
    </div>
  </div>`;
}

function stockTile(t, s) {
  const st = s?.status;
  return `<div class="tile ${st || ''}">
    <div class="pic" data-stock="${st === 'have' ? '' : 'have'}" data-key="${esc(t.key)}">${picHTML(t.key, t.name, { showName: false })}</div>
    <div class="tile-body">
      <div class="tile-name">${esc(t.name)}</div>
      <div class="row"><span class="tile-qty">× ${t.qty}</span><div class="spacer"></div>${st ? `<span class="status-tag ${st}">${{ have: 'IN STOCK', missing: 'MISSING', bought: 'BOUGHT' }[st]}</span>` : ''}</div>
      ${st === 'missing' ? `<div class="stepper">Buy: <button data-need="-1" data-key="${esc(t.key)}">−</button><span>${s.need || t.qty}</span><button data-need="1" data-key="${esc(t.key)}">+</button></div>` : ''}
      <div class="tile-btns">
        <button class="${st === 'have' ? 'on-have' : ''}" data-stock="${st === 'have' ? '' : 'have'}" data-key="${esc(t.key)}">✓ Have</button>
        <button class="${st === 'missing' ? 'on-missing' : ''}" data-stock="${st === 'missing' ? '' : 'missing'}" data-key="${esc(t.key)}">✗ Missing</button>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Shopping list view (for purchasers / shoppers)
// ---------------------------------------------------------------------------
function viewShop() {
  const list = shoppingList();
  const need = list.filter((x) => x.status === 'missing');
  const got = list.filter((x) => x.status === 'bought');
  const row = (x) => `<div class="item ${x.status === 'bought' ? 'done' : ''}">
    <div class="thumb">${img(x.key) ? `<img src="${esc(img(x.key))}" alt="">` : '🛒'}</div>
    <div class="grow"><div class="name">${esc(x.name)}</div>
      <div class="muted" style="font-size:14px">${esc(x.from)}${x.orders.length ? ` · orders ${esc(x.orders.join(', '))}` : ''}</div></div>
    <div class="big-qty">× ${x.qty}</div>
    <div class="no-print">${x.status === 'missing'
      ? `<button class="btn blue" data-stock="bought" data-key="${esc(x.key)}">✓ Bought</button>`
      : `<button class="btn small" data-stock="missing" data-key="${esc(x.key)}">Undo</button>`}</div>
  </div>`;

  return `<div class="page">
    <div class="row"><h1>Shopping list</h1><div class="spacer"></div>
      <div class="row no-print">
        <button class="btn" data-copy ${need.length ? '' : 'disabled'}>📋 Copy for WhatsApp/text</button>
        ${navigator.share ? `<button class="btn" data-share ${need.length ? '' : 'disabled'}>📤 Share</button>` : ''}
        <button class="btn" onclick="print()">🖨 Print</button>
      </div></div>
    <p class="muted no-print" style="margin-top:0">Everything we don't have in the warehouse. Send it to the shoppers. When they bring it back, tap <b>Bought</b> — the packers will see it.</p>
    ${S.day.label ? `<p class="muted">Date: ${esc(S.day.label)}</p>` : ''}
    <h2>To buy (${need.length})</h2>
    <div class="list">${need.map(row).join('') || `<div class="card muted">Nothing to buy 🎉</div>`}</div>
    ${got.length ? `<h2>Bought (${got.length})</h2><div class="list">${got.map(row).join('')}</div>` : ''}
  </div>`;
}

function shoppingText() {
  const need = shoppingList().filter((x) => x.status === 'missing');
  return `🛒 Shopping list${S.day.label ? ' ' + S.day.label : ''} (${need.length} items)\n\n` + need.map((x) => `☐ ${x.qty} × ${x.name}`).join('\n');
}

// ---------------------------------------------------------------------------
// Summary view
// ---------------------------------------------------------------------------
function viewSummary() {
  if (!day().orders.length && !totals().length) return noData();
  const st = packStats();
  const orders = day().orders.filter((o) => ui.orderFilter === 'all' || orderStatus(o) === ui.orderFilter);
  const chip = (f, label) => `<button class="chip ${ui.orderFilter === f ? 'on' : ''}" data-ofilter="${f}">${label}</button>`;
  const label = { packed: 'PACKED', missing: 'MISSING ITEM', working: 'PACKING', open: 'NOT STARTED' };
  const t = totals();
  const stock = day().stock;
  const checked = t.filter((x) => stock[x.key]).length;

  return `<div class="page">
    <h1>Summary ${S.day.label ? `<span class="muted" style="font-size:18px">· ${esc(S.day.label)}</span>` : ''}</h1>
    <div class="stats">
      <div class="stat g"><b>${st.done}</b>Orders fully packed</div>
      <div class="stat r"><b>${st.waiting}</b>Orders waiting on missing items</div>
      <div class="stat a"><b>${st.orders - st.done - st.waiting}</b>Orders left to pack</div>
      <div class="stat"><b>${st.orders}</b>Orders total</div>
      <div class="stat"><b>${st.unitsPacked} / ${st.units}</b>Units packed</div>
      <div class="stat"><b>${checked} / ${t.length}</b>Products stock-checked</div>
    </div>
    <div style="margin:14px 0">${bar(st.done, st.waiting, st.orders)}</div>
    <h2>Packers</h2>
    <div class="stats">${[0, 1].map((i) => `<div class="stat"><div style="font-weight:800;font-size:20px">${esc(packerName(i))}</div>
      <div><span style="color:var(--green);font-weight:800">${st.per[i].packed}</span> items packed · <span style="color:var(--red);font-weight:800">${st.per[i].missing}</span> missing · ${st.per[i].orders} orders finished</div>
      ${S.split.mode !== 'shared' ? `<div>${day().orders.filter((o) => o.assigned === i).length} orders assigned · ${day().orders.filter((o) => o.assigned === i && isOpen(o)).length} left</div>` : ''}
      <div class="muted" style="font-size:14px">${(() => { const o = day().orders.find((x) => x.claimedBy === i && isOpen(x)); return o ? `Now on ${esc(o.ref)}` : 'Idle'; })()}</div></div>`).join('')}</div>
    <p class="muted">Orders are divided: <b>${splitLabel()}</b> (change in Setup).</p>
    <h2>Orders</h2>
    <div class="chips">${chip('all', 'All')}${chip('open', 'Not started')}${chip('working', 'Packing')}${chip('missing', 'Missing item')}${chip('packed', 'Packed')}</div>
    <table><thead><tr><th>Ref</th><th>Recipient</th><th>Items</th><th>Status</th></tr></thead><tbody>
      ${orders.map((o) => `<tr class="click" data-order="${esc(o.ref)}"><td><b>${esc(o.ref)}</b></td><td>${esc(o.recipient)}</td>
        <td>${o.lines.map((l) => `<div>${l.status ? `<span class="status-tag ${l.status}">${l.status === 'packed' ? '✓' : '✗'}</span> ` : ''}${l.qty} × ${esc(l.name)}</div>`).join('')}</td>
        <td><span class="status-tag ${orderStatus(o)}">${label[orderStatus(o)]}</span>${o.claimedBy != null && isOpen(o) ? `<div class="muted" style="font-size:13px">${esc(packerName(o.claimedBy))}</div>` : ''}</td></tr>`).join('') || `<tr><td colspan="4" class="muted">No orders.</td></tr>`}
    </tbody></table>
  </div>`;
}

function orderDialog(ref) {
  const o = day().orders.find((x) => x.ref === ref);
  if (!o) return;
  const hasMissing = o.lines.some((l) => l.status === 'missing');
  openModal(`<div class="dlg"><h3>Order ${esc(o.ref)} — ${esc(o.recipient)}</h3>
    <div class="list">${o.lines.map((l) => `<div class="item"><div class="thumb">${img(l.key) ? `<img src="${esc(img(l.key))}" alt="">` : '📦'}</div>
      <div class="grow"><div class="name">${esc(l.name)}</div><div class="muted">× ${l.qty}${l.status ? ` · ${l.status} by ${esc(packerName(l.by))}` : ''}</div></div></div>`).join('')}</div>
    <div class="btns">
      ${hasMissing ? `<button class="btn blue full" data-dlg="reopenOrder">Put missing items back in the packing queue</button>` : ''}
      <button class="btn" data-dlg="resetOrder">Reset whole order</button>
      <button class="btn" data-close>Close</button>
    </div></div>`, (btn) => {
    if (btn.dataset.dlg === 'resetOrder' && !confirm(`Reset all items of ${o.ref} to not packed?`)) return false;
    act({ type: btn.dataset.dlg, ref: o.ref });
  });
}

// ---------------------------------------------------------------------------
// Setup view
// ---------------------------------------------------------------------------
function viewSetup() {
  const d = day();
  const products = allProducts();
  const withImg = products.filter((p) => img(p.key)).length;
  const shown = products.filter((p) => ui.photoFilter === 'all' || !img(p.key));
  const chip = (f, label) => `<button class="chip ${ui.photoFilter === f ? 'on' : ''}" data-pfilter="${f}">${label}</button>`;

  return `<div class="page">
    <h1>Setup</h1>
    <div class="card">
      <h2 style="margin-top:0">1. Import today's PDFs</h2>
      <label class="drop" id="drop">
        <input type="file" id="pdfInput" accept="application/pdf,.pdf" multiple hidden>
        <div style="font-size:40px">📄</div>
        <b>Tap to choose PDFs, or drop them here</b>
        <div class="muted">Packing Sheet(s) and the Total Items Pick List — you can pick several at once.</div>
      </label>
      <div id="importResult" style="margin-top:10px">${(ui.importLog || []).join('<br>')}</div>
      <p><b>Today:</b> ${esc(d.label || 'no date yet')} · ${d.orders.length} orders · ${totals().length} products ${d.totals.length ? '' : '<span class="muted">(totals added up from the packing sheets)</span>'}</p>
      ${d.files.length ? `<div class="muted" style="font-size:14px">${d.files.map((f) => `${esc(f.name)} — ${f.type === 'sheet' ? `${f.added} orders` : `${f.added} products`}`).join('<br>')}</div>` : ''}
      <p><button class="btn red" data-newday>🗑 Start a new day (clears lists and progress, keeps photos)</button></p>
    </div>

    <div class="card" style="margin-top:14px">
      <h2 style="margin-top:0">2. Packer names</h2>
      <div class="row">
        <label class="field">Packer 1 name<input id="p0" value="${esc(S.packers[0])}"></label>
        <label class="field">Packer 2 name<input id="p1" value="${esc(S.packers[1])}"></label>
        <button class="btn primary" data-savepackers style="align-self:flex-end">Save names</button>
      </div>
      <p>This device is: <b>${ui.packer == null ? 'not set' : esc(packerName(ui.packer))}</b> <button class="btn small" data-switch>Change</button></p>
    </div>

    ${splitSection()}

    ${photoReportSection()}

    <div class="card" style="margin-top:14px">
      <h2 style="margin-top:0">5. All product photos <span class="muted" style="font-size:16px">${withImg} of ${products.length} have a photo</span></h2>
      <p class="muted">Photos are saved by product name and remembered for future days. Tap a product to add or change its photo: paste its Amazon / Walmart / eBay listing link, paste an image link, or take a photo.</p>
      <div class="chips">${chip('none', 'Missing a photo')}${chip('all', 'All products')}</div>
      <div class="grid">${shown.map((p) => `<div class="tile"><div class="pic" data-photo="${esc(p.key)}" data-name="${esc(p.name)}">${picHTML(p.key, p.name, { camera: false, showName: false })}</div>
        <div class="tile-body"><div class="tile-name">${esc(p.name)}</div><button class="btn small" data-photo="${esc(p.key)}" data-name="${esc(p.name)}">📷 ${img(p.key) ? 'Change photo' : 'Add photo'}</button></div></div>`).join('') || `<div class="muted">All products have photos 🎉</div>`}</div>
    </div>
  </div>`;
}

function splitLabel() {
  return { shared: 'shared list — whoever is free takes the next order', half: 'first half / second half', prefix: 'by order type (Ref letters)' }[S.split.mode];
}

function prefixCounts() {
  const m = new Map();
  for (const o of day().orders) {
    const p = (o.ref.match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
    m.set(p, (m.get(p) || 0) + 1);
  }
  return [...m];
}

function splitSection() {
  const mode = S.split.mode;
  const opt = (m, title, text) => `<button class="split-opt ${mode === m ? 'on' : ''}" data-split="${m}"><b>${title}</b><span>${text}</span></button>`;
  const orders = day().orders;
  const count = (i) => orders.filter((o) => o.assigned === i).length;
  const units = (i) => orders.filter((o) => o.assigned === i).reduce((a, o) => a + o.lines.reduce((b, l) => b + l.qty, 0), 0);
  let detail = '';
  if (mode === 'half' && orders.length) {
    const first = orders.filter((o) => o.assigned === 0);
    const second = orders.filter((o) => o.assigned === 1);
    detail = `<div class="stats" style="margin-top:12px">${[0, 1].map((i) => { const list = i ? second : first; return `<div class="stat"><div style="font-weight:800">${esc(packerName(i))}</div>${list.length ? `${esc(list[0].ref)} → ${esc(list[list.length - 1].ref)}` : '—'}<div class="muted">${count(i)} orders · ${units(i)} units</div></div>`; }).join('')}</div>`;
  }
  if (mode === 'prefix') {
    const pref = S.split.prefixes;
    detail = `<p class="muted">Tap who packs each type of order. "Either" = whoever is free.</p>
      <table><thead><tr><th>Ref starts with</th><th>Orders</th><th>Packed by</th></tr></thead><tbody>
      ${prefixCounts().map(([p, n]) => `<tr><td><b>${esc(p)}</b> <span class="muted">e.g. ${esc(orders.find((o) => o.ref.toUpperCase().startsWith(p) && /^\d/.test(o.ref.slice(p.length)))?.ref || '')}</span></td><td>${n}</td><td><div class="row">
        ${[0, 1, null].map((to) => `<button class="chip ${pref[p] === to || (to === null && pref[p] == null) ? 'on' : ''}" data-prefix="${esc(p)}" data-to="${to}">${to === null ? 'Either' : esc(packerName(to))}</button>`).join('')}
      </div></td></tr>`).join('') || '<tr><td colspan="3" class="muted">Import a packing sheet first.</td></tr>'}
      </tbody></table>
      ${orders.length ? `<p>${esc(packerName(0))}: <b>${count(0)}</b> orders · ${esc(packerName(1))}: <b>${count(1)}</b> orders · Either: <b>${orders.filter((o) => o.assigned == null).length}</b></p>` : ''}`;
  }
  return `<div class="card" style="margin-top:14px">
    <h2 style="margin-top:0">3. How to divide orders between the packers</h2>
    <div class="split-opts">
      ${opt('shared', '🔁 Shared list', 'Both work down the same list. Whoever is free takes the next order. Nobody waits, nobody gets the same order.')}
      ${opt('half', '✂️ Half and half', `${esc(packerName(0))} gets the first half of the sheet, ${esc(packerName(1))} the second half (balanced by number of units).`)}
      ${opt('prefix', '🏷 By order type', 'Choose by the Ref letters, e.g. EB orders to one packer, WS orders to the other.')}
    </div>
    ${detail}
    ${mode !== 'shared' ? `<p class="muted" style="font-size:14px">When a packer finishes their share, they get a "Help" button to take the other packer's remaining orders.</p>` : ''}
  </div>`;
}

function photoReportSection() {
  const info = S.catalogInfo || { count: 0, sources: {} };
  const sug = ui.suggestions;
  return `<div class="card" style="margin-top:14px">
    <h2 style="margin-top:0">4. Listing photos from Amazon / Walmart / eBay</h2>
    <p class="muted" style="margin-top:0">Import your listing reports once. The app keeps them, and every product on today's and future packing sheets gets the real listing photo.</p>
    <details style="margin-bottom:12px"><summary><b>Which report to download?</b></summary>
      <ul>
        <li><b>Amazon</b> Seller Central → Inventory → Inventory Reports → <i>All Listings Report</i> (has <code>item-name</code> and <code>image-url</code>). The <i>Category Listings Report</i> (<code>main-image-url</code>) works too.</li>
        <li><b>Walmart</b> Seller Center → Items → Download → <i>Item report</i> (needs the product name and primary image URL columns).</li>
        <li><b>eBay</b> Seller Hub → Reports → Downloads → active listings report, or a File Exchange / bulk listing export with picture URLs.</li>
        <li>Anything else: any CSV / Excel file with a product title column and an image link column.</li>
      </ul>
      <p class="muted">Excel (.xlsx), CSV and tab-separated .txt files all work.</p>
    </details>
    <label class="drop" id="dropReport">
      <input type="file" id="reportInput" accept=".csv,.tsv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple hidden>
      <div style="font-size:36px">🖼</div>
      <b>Tap to choose listing reports, or drop them here</b>
    </label>
    <div style="margin-top:10px">${ui.photoLog.join('<br>')}</div>
    <p>Saved listings: <b>${info.count}</b> ${Object.entries(info.sources).map(([k, v]) => `· ${esc(k)} ${v}`).join(' ')}
      ${info.count ? `<button class="btn small" data-clearcatalog>Clear saved listings</button>` : ''}</p>
    <h3>Check suggested photos ${sug ? `(${sug.length})` : ''}</h3>
    <p class="muted" style="margin-top:0">Names that match a listing exactly get the photo automatically. For close matches, check it's the same product, flavour and size, then tap the right photo.</p>
    ${sug == null ? '<p class="muted">Loading…</p>' : sug.length ? `<div class="list">${sug.map(suggestionRow).join('')}</div>` : `<p class="muted">Nothing to check.</p>`}
  </div>`;
}

function suggestionRow(p) {
  return `<div class="card sug">
    <div class="name" style="font-size:18px">${esc(p.name)}</div>
    <div class="sug-cands">${p.candidates.map((c, i) => `<button class="sug-cand" data-accept="${esc(p.key)}" data-idx="${i}">
      <img src="${esc(c.image)}" alt="" loading="lazy"><span class="sug-title">${esc(c.title)}</span>
      <span class="muted" style="font-size:13px">${esc(c.source)} · ${Math.round(c.score * 100)}% match</span>
      ${c.score < 0.9 ? '<span class="sug-warn">⚠ Check flavour / size</span>' : ''}<span class="btn small green">✓ This one</span></button>`).join('')}
      <button class="sug-cand none" data-skip="${esc(p.key)}"><span style="font-size:30px">✗</span><span>None of these</span></button>
    </div></div>`;
}

async function loadSuggestions() {
  try {
    ui.suggestions = await (await fetch('/api/suggestions')).json();
  } catch {
    ui.suggestions = [];
  }
  ui.suggestions = ui.suggestions.filter((p) => !(ui.skipped || new Set()).has(p.key));
  if (ui.view === 'setup') render();
}

async function importReports(files) {
  ui.photoLog = [];
  for (const f of files) {
    try {
      const r = await fetch('/api/catalog', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: f });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      ui.photoLog.push(`✅ ${esc(f.name)} (${esc(j.source)}): ${j.withImage} listings with photos (titles from "${esc(j.columns.title)}", photos from "${esc(j.columns.image)}") · ${j.photos} product photo(s) set automatically`);
    } catch (e) {
      ui.photoLog.push(`❌ ${esc(e.message || f.name)}`);
    }
    render();
  }
  loadSuggestions();
}

async function importFiles(files) {
  const lines = (ui.importLog = []);
  for (const f of files) {
    try {
      const r = await fetch('/api/import', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: f });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      lines.push(`✅ ${esc(f.name)}: ${j.type === 'sheet' ? `${j.added} orders added${j.skipped ? `, ${j.skipped} already loaded` : ''}` : `${j.added} products in the total list`}`);
    } catch (e) {
      lines.push(`❌ ${esc(e.message || f.name)}`);
    }
    const out = $('#importResult');
    if (out) out.innerHTML = lines.join('<br>');
  }
  toast('Import finished');
  loadSuggestions();
}

// ---------------------------------------------------------------------------
// Photo dialog
// ---------------------------------------------------------------------------
function photoDialog(key, name) {
  const src = img(key);
  openModal(`<div class="dlg">
    <h3>${esc(name)}</h3>
    <div class="pic">${src ? `<img src="${esc(src)}" alt="">` : '<div class="noimg">No photo yet</div>'}</div>
    ${src && S.imageMeta?.[key]?.source ? `<div class="muted" style="font-size:14px">From: ${esc(S.imageMeta[key].source)} ${esc(S.imageMeta[key].title || '')}</div>` : ''}
    <div class="btns">
      <label class="btn primary" style="text-align:center">📷 Take photo<input type="file" accept="image/*" capture="environment" data-file hidden></label>
      <label class="btn" style="text-align:center">🖼 Choose picture<input type="file" accept="image/*" data-file hidden></label>
      <input class="search full" id="listingUrl" placeholder="Paste the Amazon / Walmart / eBay listing link">
      <button class="btn blue full" data-dlg="listing">Use the listing's photo</button>
      <div class="full row" style="gap:6px">Find the listing:
        ${[['Amazon', 'https://www.amazon.ca/s?k='], ['Walmart', 'https://www.walmart.ca/search?q='], ['eBay', 'https://www.ebay.ca/sch/i.html?_nkw='], ['Google Images', 'https://www.google.com/search?tbm=isch&q=']]
          .map(([n, u]) => `<a class="btn small" style="text-decoration:none" target="_blank" rel="noopener" href="${u}${encodeURIComponent(name)}">🔎 ${n}</a>`).join('')}
      </div>
      <input class="search full" id="imgUrl" placeholder="…or paste an image address (right-click / long-press the photo → Copy image address)">
      <button class="btn" data-dlg="url">Save image address</button>
      ${src ? `<button class="btn red" data-dlg="remove">Remove photo</button>` : '<span></span>'}
      <button class="btn full" data-close>Close</button>
    </div>
    <div id="photoStatus" class="muted"></div>
  </div>`, (btn) => {
    if (btn.dataset.dlg === 'url') {
      const url = $('#imgUrl').value.trim();
      if (!url) return false;
      act({ type: 'imageUrl', key, url });
    }
    if (btn.dataset.dlg === 'remove') act({ type: 'imageUrl', key, url: null });
    if (btn.dataset.dlg === 'listing') {
      const url = $('#listingUrl').value.trim();
      if (!url) return false;
      $('#photoStatus').textContent = 'Getting the photo from the listing…';
      fetch('/api/listing-photo', { method: 'POST', body: JSON.stringify({ key, url }) })
        .then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j.error);
          closeModal();
          toast('Listing photo saved');
          loadSuggestions();
        })
        .catch((e) => ($('#photoStatus').textContent = e.message));
      return false;
    }
  });
  $('#modal').querySelectorAll('[data-file]').forEach((inp) =>
    inp.addEventListener('change', async () => {
      const file = inp.files[0];
      if (!file) return;
      $('#photoStatus').textContent = 'Saving photo…';
      try {
        const blob = await shrinkImage(file);
        const r = await fetch(`/api/image?key=${encodeURIComponent(key)}`, { method: 'POST', body: blob });
        if (!r.ok) throw new Error((await r.json()).error);
        closeModal();
        toast('Photo saved');
      } catch (e) {
        $('#photoStatus').textContent = 'Could not save photo: ' + e.message;
      }
    })
  );
}

// Resize to max 1200px JPEG so photos load fast on every tablet.
async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Not an image'));
      i.src = url;
    });
    const scale = Math.min(1, 1200 / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * scale);
    c.height = Math.round(im.naturalHeight * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(im, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
let modalHandler = null;
function openModal(html, onButton) {
  const m = $('#modal');
  m.innerHTML = html;
  modalHandler = onButton;
  if (!m.open) m.showModal();
}
function closeModal() {
  $('#modal').close();
}
$('#modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) return closeModal();
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.hasAttribute('data-close')) return closeModal();
  if (modalHandler && modalHandler(btn) !== false) closeModal();
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function go(view) {
  if (view === 'setup' && ui.view !== 'setup') loadSuggestions();
  ui.view = view;
  localStorage.setItem('view', view);
  render();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-help],[data-split],[data-prefix],[data-accept],[data-skip],[data-clearcatalog],[data-view],[data-go],[data-packer],[data-switch],[data-photo],[data-mark],[data-act],[data-stock],[data-stock-undo],[data-need],[data-walk],[data-sfilter],[data-ofilter],[data-pfilter],[data-order],[data-copy],[data-share],[data-newday],[data-savepackers]');
  if (!t || t.closest('#modal')) return;
  const d = t.dataset;

  if (t.hasAttribute('data-help')) {
    ui.helping = true;
    return render();
  }
  if (d.split) return act({ type: 'split', mode: d.split });
  if (d.prefix) return act({ type: 'split', mode: 'prefix', prefix: d.prefix, to: d.to === 'null' ? null : Number(d.to) });
  if (d.accept) {
    const p = ui.suggestions.find((x) => x.key === d.accept);
    const c = p && p.candidates[Number(d.idx)];
    if (!c) return;
    ui.suggestions = ui.suggestions.filter((x) => x.key !== p.key);
    return act({ type: 'imageUrl', key: p.key, url: c.image, source: c.source, title: c.title });
  }
  if (d.skip) {
    (ui.skipped = ui.skipped || new Set()).add(d.skip);
    ui.suggestions = ui.suggestions.filter((x) => x.key !== d.skip);
    return render();
  }
  if (t.hasAttribute('data-clearcatalog')) {
    if (confirm('Forget all imported listings? Photos already set on products are kept.')) act({ type: 'clearCatalog' }).then(loadSuggestions);
    return;
  }
  if (d.view) return go(d.view);
  if (d.go) return go(d.go);
  if (d.packer != null) {
    ui.packer = Number(d.packer);
    localStorage.setItem('packer', d.packer);
    return go('pack');
  }
  if (t.hasAttribute('data-switch')) {
    ui.helping = false;
    if (ui.packer != null) act({ type: 'release' });
    ui.packer = null;
    localStorage.removeItem('packer');
    return go('pack');
  }
  if (d.photo) {
    e.stopPropagation();
    return photoDialog(d.photo, d.name);
  }
  if (d.mark) {
    flash(d.mark === 'packed');
    return act({ type: 'mark', id: d.id, status: d.mark, help: ui.helping });
  }
  if (d.act) return act({ type: d.act });
  if (d.stock !== undefined && d.key) {
    if (ui.stockWalk && d.stock) {
      flash(d.stock === 'have');
      ui.lastWalk = d.key;
    }
    if (d.stock === 'bought') toast('Marked bought — packers will see it');
    return act({ type: 'stock', key: d.key, status: d.stock || null });
  }
  if (t.hasAttribute('data-stock-undo')) {
    if (!ui.lastWalk) return toast('Nothing to undo');
    act({ type: 'stock', key: ui.lastWalk, status: null });
    ui.lastWalk = null;
    return;
  }
  if (d.need) {
    const s = day().stock[d.key];
    const t0 = totals().find((x) => x.key === d.key);
    const cur = s?.need || t0?.qty || 1;
    return act({ type: 'stock', key: d.key, status: 'missing', need: Math.max(1, cur + Number(d.need)) });
  }
  if (d.walk) {
    ui.stockWalk = d.walk === '1';
    return render();
  }
  if (d.sfilter) {
    ui.stockFilter = d.sfilter;
    return render();
  }
  if (d.ofilter) {
    ui.orderFilter = d.ofilter;
    return render();
  }
  if (d.pfilter) {
    ui.photoFilter = d.pfilter;
    return render();
  }
  if (d.order) return orderDialog(d.order);
  if (t.hasAttribute('data-copy')) {
    const text = shoppingText();
    (navigator.clipboard?.writeText(text) || Promise.reject())
      .then(() => toast('Copied — paste it in WhatsApp or a text'))
      .catch(() => openModal(`<div class="dlg"><h3>Copy this list</h3><textarea style="height:300px;font:inherit">${esc(text)}</textarea><button class="btn" data-close>Close</button></div>`));
    return;
  }
  if (t.hasAttribute('data-share')) return navigator.share({ title: 'Shopping list', text: shoppingText() }).catch(() => {});
  if (t.hasAttribute('data-newday')) {
    if (confirm('Start a new day? This clears today\'s orders, stock check and progress for BOTH packers. Photos are kept.')) act({ type: 'newDay' });
    return;
  }
  if (t.hasAttribute('data-savepackers')) {
    act({ type: 'packers', names: [$('#p0').value, $('#p1').value] });
    return toast('Names saved');
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'stockSearch') {
    ui.stockQuery = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const inp = $('#stockSearch');
    inp.focus();
    inp.setSelectionRange(pos, pos);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'pdfInput' && e.target.files.length) importFiles([...e.target.files]);
  if (e.target.id === 'reportInput' && e.target.files.length) importReports([...e.target.files]);
});
['dragover', 'dragleave', 'drop'].forEach((type) =>
  document.addEventListener(type, (e) => {
    const drop = e.target.closest && e.target.closest('#drop, #dropReport');
    if (!drop) return;
    e.preventDefault();
    drop.classList.toggle('over', type === 'dragover');
    if (type !== 'drop') return;
    if (drop.id === 'dropReport') importReports([...e.dataTransfer.files]);
    else importFiles([...e.dataTransfer.files].filter((f) => /pdf$/i.test(f.name) || f.type === 'application/pdf'));
  })
);

// Keyboard shortcuts for a packing station with a keyboard/scanner:
// Enter/Space = packed, X/Backspace = missing, Z = back.
document.addEventListener('keydown', (e) => {
  if (ui.view !== 'pack' || $('#modal').open || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  const ok = $('.pack [data-mark="packed"]');
  if (!ok) return;
  if (e.key === 'Enter' || e.key === ' ') ok.click();
  else if (e.key === 'x' || e.key === 'Backspace') $('.pack [data-mark="missing"]')?.click();
  else if (e.key === 'z') $('.pack [data-act="undo"]')?.click();
  else return;
  e.preventDefault();
});

connect();
if (ui.view === 'setup') loadSuggestions();
