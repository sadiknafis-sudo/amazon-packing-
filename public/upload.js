'use strict';
// Back-office page: upload today's PDFs + the listing links file, and see
// which products still need a link or a photo.
let S = null;
const ui = { log: [], busy: false, newDay: null, incoming: null, matches: null, query: '' };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 2500);
}

async function start() {
  const r = await fetch('/api/state');
  if (r.status === 401) return pinScreen();
  const es = new EventSource('/api/events');
  es.onopen = () => $('#conn').classList.add('ok');
  es.onerror = () => $('#conn').classList.remove('ok');
  es.onmessage = (e) => {
    S = JSON.parse(e.data);
    render();
  };
}

function pinScreen(msg = '') {
  $('#view').innerHTML = `<div class="page"><div class="card" style="max-width:420px;margin:40px auto">
    <h1>Enter PIN</h1><form id="pinForm" class="row"><input class="search" id="pin" type="password" inputmode="numeric" autofocus>
    <button class="btn primary">Open</button></form><p style="color:var(--red)">${esc(msg)}</p></div></div>`;
  $('#pinForm').onsubmit = async (e) => {
    e.preventDefault();
    const r = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ pin: $('#pin').value }) });
    if (r.ok) start();
    else pinScreen('Wrong PIN');
  };
}

// ---------------------------------------------------------------------------
// "Send to Packing App" bookmark: runs on an Amazon / Walmart / eBay listing
// in the back office's own browser, picks up the main photo, title and link,
// and opens this page to choose which product it is. Because it runs in their
// browser, marketplaces can't block it the way they block the server.
// ---------------------------------------------------------------------------
function bookmarkletCode() {
  const src = function (ORIGIN) {
    var q = function (s) { return document.querySelector(s); };
    var meta = function (p) { var e = q('meta[property="' + p + '"],meta[name="' + p + '"]'); return e && e.content; };
    var img = null;
    var li = q('#landingImage') || q('#imgTagWrapperId img') || q('#imgBlkFront');
    if (li) {
      try {
        var dyn = JSON.parse(li.getAttribute('data-a-dynamic-image') || '{}');
        var best = 0;
        for (var u in dyn) if (dyn[u][0] * dyn[u][1] > best) { best = dyn[u][0] * dyn[u][1]; img = u; }
      } catch (e) {}
      img = li.getAttribute('data-old-hires') || img || li.src;
    }
    if (!img) { var eb = q('.ux-image-carousel-item.active img') || q('.ux-image-carousel-item img'); if (eb) img = eb.getAttribute('data-zoom-src') || eb.src; }
    if (!img) { var wm = q('[data-testid="hero-image"] img') || q('img[data-testid="hero-image"]'); if (wm) img = wm.src; }
    if (!img) img = meta('og:image') || meta('twitter:image');
    if (!img) {
      var big = 0;
      [].forEach.call(document.images, function (i) { var a = i.naturalWidth * i.naturalHeight; if (a > big && /^https?:/.test(i.src)) { big = a; img = i.src; } });
    }
    var t = (q('#productTitle') || q('h1.x-item-title__mainTitle') || q('h1') || {}).innerText || meta('og:title') || document.title;
    if (!img) { alert('Packing app: no product photo found on this page.'); return; }
    var link = location.href.split('#')[0];
    var asin = link.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
    if (asin) link = location.origin + '/dp/' + asin[1];
    else if (/ebay\./.test(location.hostname)) link = link.split('?')[0];
    window.open(ORIGIN + '/upload.html#add=' + encodeURIComponent(JSON.stringify({ i: img, t: String(t).trim().slice(0, 300), u: link })), 'packingapp');
  };
  return `(${src.toString()})(${JSON.stringify(location.origin)})`;
}

function readIncoming() {
  const m = location.hash.match(/^#add=(.+)$/);
  if (!m) return;
  try {
    const d = JSON.parse(decodeURIComponent(m[1]));
    ui.incoming = { image: d.i, title: d.t || '', link: d.u || '' };
  } catch {
    ui.incoming = null;
  }
  history.replaceState(null, '', location.pathname);
  ui.matches = null;
  ui.query = '';
  fetch('/api/match?title=' + encodeURIComponent(ui.incoming?.title || ''))
    .then((r) => r.json())
    .then((list) => {
      ui.matches = list;
      render();
    });
}

function incomingCard() {
  const inc = ui.incoming;
  const site = /amazon|amzn/.test(inc.link) ? 'Amazon' : /walmart/.test(inc.link) ? 'Walmart' : /ebay/.test(inc.link) ? 'eBay' : 'listing';
  const q = ui.query.trim().toLowerCase();
  const list = (ui.matches || []).filter((p) => !q || p.name.toLowerCase().includes(q));
  const top = q ? list.slice(0, 30) : list.filter((p, i) => i < 5 || p.score >= 0.5).slice(0, 12);
  return `<div class="card incoming">
    <h1 style="margin-top:0">Which product is this ${site} listing?</h1>
    <div class="incoming-grid">
      <div class="pic"><img src="${esc(inc.image)}" alt=""></div>
      <div>
        <div style="font-weight:700;font-size:18px">${esc(inc.title)}</div>
        <div class="muted" style="font-size:13px;word-break:break-all;margin:4px 0 12px">${esc(inc.link)}</div>
        <input class="search" id="prodSearch" placeholder="Search today's products…" value="${esc(ui.query)}" style="width:100%">
        <div class="list" style="margin-top:10px">
          ${ui.matches == null ? '<p class="muted">Finding matches…</p>' : top.map((p) => `<button class="item pick" data-pick="${esc(p.key)}">
            <div class="grow"><div class="name">${esc(p.name)}</div>
            <div class="muted" style="font-size:13px">${p.score >= 0.3 ? `${Math.round(p.score * 100)}% match · ` : ''}${p.hasPhoto ? 'has a photo (will be replaced)' : 'no photo yet'}</div></div>
            <span class="btn small green">✓ This one</span></button>`).join('') || '<p class="muted">No product found.</p>'}
        </div>
        <details style="margin-top:12px"><summary>Not on today's list? Save it for a future day</summary>
          <div class="row" style="margin-top:8px"><input class="search" id="newName" placeholder="Product name exactly as on the packing sheet" value="${esc(inc.title)}">
          <button class="btn primary" id="saveNew">Save</button></div></details>
        <p><button class="btn" id="cancelIncoming">Cancel</button></p>
      </div>
    </div>
  </div>`;
}

async function saveIncoming(body) {
  const r = await fetch('/api/action', { method: 'POST', body: JSON.stringify({ type: 'setListing', image: ui.incoming.image, link: ui.incoming.link, title: ui.incoming.title, ...body }) });
  const j = await r.json();
  if (!r.ok) return toast(j.error || 'Could not save');
  ui.incoming = null;
  render();
  toast('Saved ✓ — go back to the marketplace tab for the next product');
}

function bookmarkletCard() {
  return `<div class="card" style="margin-top:14px">
    <h2 style="margin-top:0">📌 Easiest way: the "Send to Packing App" button</h2>
    <ol>
      <li>On a computer, show the browser's bookmarks bar (Chrome/Edge: <b>Ctrl+Shift+B</b>, Mac: <b>⌘+Shift+B</b>).</li>
      <li><b>Drag this button onto the bookmarks bar:</b> <a class="bookmarklet" id="bm" href="#">📌 Send to Packing App</a></li>
      <li>Open a product's listing on Amazon, Walmart or eBay and click <b>📌 Send to Packing App</b> on the bookmarks bar.</li>
      <li>This page opens with the listing's photo. Tap which product it is. Done. The photo and the listing link are saved.</li>
    </ol>
    <p class="muted">Use the list under "No link and no photo yet" below to see which products still need one. The button works on any site that shows a product photo.</p>
  </div>`;
}

function products() {
  const map = new Map();
  for (const t of S.day.totals) map.set(t.key, { key: t.key, name: t.name, qty: t.qty });
  for (const o of S.day.orders)
    for (const l of o.lines) {
      if (!map.has(l.key)) map.set(l.key, { key: l.key, name: l.name, qty: 0, refs: [] });
      const p = map.get(l.key);
      (p.refs = p.refs || []).push(o.ref);
      if (!S.day.totals.length) p.qty += l.qty;
    }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const linkBtns = (key) =>
  (S.links[key] || []).map((l) => `<a class="btn small" style="text-decoration:none" target="_blank" rel="noopener" href="${esc(l.url)}">${esc({ amazon: 'Amazon', walmart: 'Walmart', ebay: 'eBay', image: 'Image', other: 'Link' }[l.kind])} ↗</a>`).join(' ');

function render() {
  if (!S) return;
  const d = S.day;
  const list = products();
  const withPhoto = list.filter((p) => S.images[p.key]);
  const failed = list.filter((p) => !S.images[p.key] && S.photoJobs.failed[p.key]);
  const noLink = list.filter((p) => !S.images[p.key] && !S.links[p.key]);
  const fetching = S.photoJobs.pending;
  const lastImport = d.files.length ? d.files[d.files.length - 1].at : 0;
  if (ui.newDay === null) ui.newDay = d.orders.length > 0 && Date.now() - lastImport > 12 * 3600 * 1000;

  const bm = () => {
    const a = $('#bm');
    if (a) {
      a.href = 'javascript:' + encodeURIComponent(bookmarkletCode());
      a.onclick = (e) => {
        e.preventDefault();
        toast('Drag this button to your bookmarks bar, then click it on a listing page');
      };
    }
  };
  if (ui.incoming) {
    $('#view').innerHTML = `<div class="page">${incomingCard()}</div>`;
    return;
  }
  setTimeout(bm);
  $('#view').innerHTML = `<div class="page">
    <h1>Upload today's files</h1>
    <div class="card">
      <p style="margin-top:0">Drop <b>everything at once</b>: the <b>Packing Sheet</b> PDF(s), the <b>Total Items Pick List</b> PDF and the <b>listing links</b> file (Excel or CSV).
      The app works out which file is which.</p>
      <label class="row" style="margin-bottom:10px;font-weight:600"><input type="checkbox" id="newDay" ${ui.newDay ? 'checked' : ''} style="width:22px;height:22px">
        Start a new day first (clears ${d.label ? esc(d.label) : 'the current'} orders, stock check and progress; photos and links are kept)</label>
      <label class="drop" id="drop">
        <input type="file" id="files" multiple hidden accept=".pdf,.csv,.tsv,.txt,.xlsx,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
        <div style="font-size:40px">📤</div><b>${ui.busy ? 'Uploading…' : 'Tap to choose files, or drop them here'}</b>
        <div class="muted">PDF · Excel (.xlsx) · CSV</div>
      </label>
      <div style="margin-top:10px">${ui.log.join('<br>')}</div>
    </div>

    ${bookmarkletCard()}

    <div class="card" style="margin-top:14px">
      <h2 style="margin-top:0">Or: a links file for many products at once</h2>
      <p>One row per product with its listing links. The product name should be written the same way as on the packing sheet. You can also give an order <b>Ref</b> instead of the name.</p>
      <table><thead><tr><th>Ref</th><th>Product</th><th>Amazon link</th><th>Walmart link</th><th>eBay link</th><th>Image link</th></tr></thead>
        <tbody><tr><td></td><td>Dawn Orange 502ml</td><td>https://www.amazon.ca/dp/…</td><td></td><td></td><td></td></tr>
        <tr><td>EB2</td><td></td><td></td><td></td><td>https://www.ebay.ca/itm/…</td><td></td></tr></tbody></table>
      <ul class="muted">
        <li>Any of the link columns can be empty. One link per product is enough.</li>
        <li>Links can be typed or pasted as text, or be Excel hyperlinks. A product name that is itself a hyperlink works too.</li>
        <li>The app opens each listing and takes its <b>main photo</b>. An <b>Image link</b> (the photo's own address) is used as is, and is the most reliable.</li>
        <li>Links are remembered, so you only need to send new or changed products each day.</li>
      </ul>
      <div class="row"><a class="btn" href="links-template.csv" download>⬇ Download empty template</a>
        <button class="btn primary" id="dlMissing" ${noLink.length + failed.length ? '' : 'disabled'}>⬇ Download today's products that still need a link (${noLink.length + failed.length})</button></div>
    </div>

    <div class="card" style="margin-top:14px">
      <h2 style="margin-top:0">Today ${d.label ? `· ${esc(d.label)}` : ''}</h2>
      <div class="stats">
        <div class="stat"><b>${d.orders.length}</b>Orders</div>
        <div class="stat"><b>${list.length}</b>Products</div>
        <div class="stat g"><b>${withPhoto.length}</b>Have a photo</div>
        <div class="stat a"><b>${fetching}</b>Getting photos…</div>
        <div class="stat r"><b>${failed.length + noLink.length}</b>Need attention</div>
      </div>
      ${failed.length ? `<h2>Couldn't get a photo from the link (${failed.length})</h2>
        <p class="muted">The site may have blocked it, or the link is wrong. Open the listing to check the link. You can fix it by adding the <b>Image link</b> (right-click the main photo → Copy image address) to the links file and uploading it again.</p>
        <div class="list">${failed.map((p) => `<div class="item"><div class="grow"><div class="name">${esc(p.name)}</div>
          <div class="muted" style="font-size:13px">${S.photoJobs.failed[p.key].errors.map(esc).join('<br>')}</div></div>
          <div class="row">${linkBtns(p.key)}<button class="btn small" data-retry="${esc(p.key)}">↻ Retry</button></div></div>`).join('')}</div>
        <p><button class="btn" id="retryAll">↻ Retry all</button></p>` : ''}
      ${noLink.length ? `<h2>No link and no photo yet (${noLink.length})</h2>
        <div class="list">${noLink.map((p) => `<div class="item"><div class="grow"><div class="name">${esc(p.name)}</div>
          <div class="muted" style="font-size:13px">${p.refs ? 'Orders ' + esc(p.refs.join(', ')) : 'Total list only'}</div></div></div>`).join('')}</div>` : ''}
      ${list.length && !failed.length && !noLink.length ? `<p>✅ Every product has a photo${fetching ? ' or is being fetched' : ''}.</p>` : ''}
    </div>
  </div>`;
}

async function upload(files) {
  if (!files.length || ui.busy) return;
  ui.busy = true;
  ui.log = [];
  const newDay = $('#newDay')?.checked;
  // PDFs first so links can be matched to today's orders.
  files.sort((a, b) => (/\.pdf$/i.test(b.name) ? 1 : 0) - (/\.pdf$/i.test(a.name) ? 1 : 0));
  if (newDay) {
    await fetch('/api/action', { method: 'POST', body: JSON.stringify({ type: 'newDay' }) });
    ui.log.push('🗓 Started a new day');
  }
  for (const f of files) {
    try {
      const r = await fetch('/api/upload', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: f });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      const what = {
        sheet: () => `Packing Sheet: ${j.added} orders added${j.skipped ? ` (${j.skipped} were already loaded)` : ''}${j.linked ? `, ${j.linked} products with links` : ''}`,
        totals: () => `Total Items list: ${j.added} products${j.linked ? `, ${j.linked} with links` : ''}`,
        links: () => `Links file: ${j.linked} products with links (${j.today} on today's lists)${j.unmatched.length ? ` · ⚠ not found: ${esc(j.unmatched.slice(0, 8).join(', '))}${j.unmatched.length > 8 ? '…' : ''}` : ''}`,
        catalog: () => `${esc(j.source)} listing report: ${j.withImage} listings with photos, ${j.photos} matched automatically`,
      }[j.kind]();
      ui.log.push(`✅ <b>${esc(f.name)}</b> — ${what}`);
    } catch (e) {
      ui.log.push(`❌ <b>${esc(f.name)}</b> — ${esc(e.message)}`);
    }
    render();
  }
  ui.busy = false;
  ui.newDay = false;
  render();
  toast('Upload finished');
}

function downloadMissing() {
  const list = products().filter((p) => !S.images[p.key]);
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['Ref', 'Product', 'Amazon link', 'Walmart link', 'eBay link', 'Image link']];
  for (const p of list) {
    const links = S.links[p.key] || [];
    const get = (k) => links.find((l) => l.kind === k)?.url || '';
    rows.push(['', p.name, get('amazon'), get('walmart'), get('ebay'), get('image')]);
  }
  const blob = new Blob(['﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `links-needed-${(S.day.label || 'today').replace(/\//g, '-')}.csv` });
  a.click();
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'prodSearch') {
    ui.query = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const inp = $('#prodSearch');
    inp.focus();
    inp.setSelectionRange(pos, pos);
  }
});
window.addEventListener('hashchange', () => {
  readIncoming();
  render();
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'files') upload([...e.target.files]);
  if (e.target.id === 'newDay') ui.newDay = e.target.checked;
});
document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'dlMissing') downloadMissing();
  if (t.dataset.pick) saveIncoming({ key: t.dataset.pick });
  if (t.id === 'saveNew') {
    const name = $('#newName').value.trim();
    if (name) saveIncoming({ name });
  }
  if (t.id === 'cancelIncoming') {
    ui.incoming = null;
    render();
  }
  if (t.id === 'retryAll') fetch('/api/action', { method: 'POST', body: JSON.stringify({ type: 'retryAllPhotos' }) });
  if (t.dataset.retry) fetch('/api/action', { method: 'POST', body: JSON.stringify({ type: 'retryPhoto', key: t.dataset.retry }) });
});
['dragover', 'dragleave', 'drop'].forEach((type) =>
  document.addEventListener(type, (e) => {
    const drop = e.target.closest && e.target.closest('#drop');
    if (!drop) return;
    e.preventDefault();
    drop.classList.toggle('over', type === 'dragover');
    if (type === 'drop') upload([...e.dataTransfer.files]);
  })
);

readIncoming();
start();
