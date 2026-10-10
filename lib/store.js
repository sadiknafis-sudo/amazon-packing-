// In-memory state + JSON persistence + all the actions packers can take.
// Everything runs on Node's single thread, so each action is atomic: two
// packers can never claim the same order.
import fs from 'node:fs';
import path from 'node:path';
import { itemKey } from './parse.js';
import { bestMatches, matchScore } from './catalog.js';
import { fetchListingImage, classifyUrl as classifyUrlKind, SOURCE_NAME } from './listing.js';

// Which listing to try first when fetching a photo (eBay pages are the most
// reliable to read, Amazon the least).
const FETCH_ORDER = ['ebay', 'walmart', 'amazon', 'other'];

// Sales account for each order Ref prefix. Shown in big colours on every order
// so packers use the right slip/insert. Editable in Setup.
// Colours avoid green and red, which mean packed / missing.
export const DEFAULT_ACCOUNTS = {
  EB: { name: 'eBay', color: '#1d4ed8' },
  CN: { name: 'CDI Canada', color: '#be185d' },
  C: { name: 'USA Amazon', color: '#ea580c' },
  M: { name: 'Mehmet USA Amazon', color: '#7c3aed' },
  WE: { name: 'Weston USA Amazon', color: '#0f766e' },
  P: { name: 'Purenest Amazon', color: '#a16207' },
  SP: { name: 'Shopify CDI', color: '#0891b2' },
};

const EMPTY_DAY = () => ({
  label: null,
  files: [],
  totals: [], // [{key, name, qty}] from the Total Items Pick List
  orders: [], // [{ref, recipient, assigned, claimedBy, lines:[{id, key, name, qty, status, by, at}]}]
  stock: {}, // key -> {status: 'have'|'missing'|'bought', need, by, at}
});

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    this.imageDir = path.join(dataDir, 'images');
    fs.mkdirSync(this.imageDir, { recursive: true });
    this.state = {
      version: 0,
      packers: ['Packer 1', 'Packer 2'],
      images: {}, // key -> url (kept across days)
      imageMeta: {}, // key -> {source, title} of the listing the photo came from
      // How orders are divided: 'shared' (whoever is free takes the next one),
      // 'half' (first half / second half) or 'prefix' (by Ref letters, e.g. EB, WS).
      split: { mode: 'shared', prefixes: {} },
      accounts: {}, // Ref prefix -> {name, color}
      catalogInfo: { count: 0, sources: {} },
      links: {}, // key -> [{url, kind}] listing links from the back office (kept across days)
      photoJobs: { pending: 0, failed: {} }, // fetching photos from listing links
      day: EMPTY_DAY(),
    };
    if (fs.existsSync(this.file)) {
      try {
        Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, 'utf8')));
      } catch (e) {
        console.error('Could not read saved state, starting fresh:', e.message);
      }
    }
    // Add default accounts that aren't set yet (never overwrite edits).
    for (const [prefix, acc] of Object.entries(DEFAULT_ACCOUNTS))
      if (!this.state.accounts[prefix]) this.state.accounts[prefix] = { ...acc };
    this.catalogFile = path.join(dataDir, 'catalog.json');
    this.catalog = fs.existsSync(this.catalogFile) ? JSON.parse(fs.readFileSync(this.catalogFile, 'utf8')) : [];
    this.listeners = new Set();
    this.queue = [];
    this.running = 0;
    this.state.photoJobs.pending = 0;
    // Finish fetching photos that were still waiting when the server stopped.
    setImmediate(() => this.queueMissingPhotos());
  }

  save() {
    this.state.version++;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
    for (const fn of this.listeners) fn(this.state);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---- imports ---------------------------------------------------------

  importParsed(parsed, filename) {
    const day = this.state.day;
    if (parsed.date && !day.label) day.label = parsed.date;
    let added = 0;
    let skipped = 0;
    if (parsed.type === 'totals') {
      day.totals = parsed.totals.map((t) => ({ key: itemKey(t.name), name: t.name, qty: t.qty }));
      added = day.totals.length;
    } else if (parsed.type === 'sheet') {
      const known = new Set(day.orders.map((o) => o.ref));
      for (const o of parsed.orders) {
        if (known.has(o.ref)) {
          skipped++;
          continue;
        }
        day.orders.push({
          ref: o.ref,
          recipient: o.recipient,
          assigned: null,
          claimedBy: null,
          lines: o.lines.map((l, i) => ({
            id: `${o.ref}-${i}`,
            key: itemKey(l.name),
            name: l.name,
            qty: l.qty,
            status: null,
            by: null,
            at: null,
          })),
        });
        added++;
      }
    }
    day.files.push({ name: filename, type: parsed.type, added, at: Date.now() });
    this.assignOrders();
    const photos = this.autoPhotos();
    // Links embedded in the PDF itself (item names linked to their listings).
    const pdfLinks = [];
    for (const l of parsed.type === 'totals' ? parsed.totals : (parsed.orders || []).flatMap((o) => o.lines))
      if (l.links && l.links.length) pdfLinks.push({ name: l.name, links: l.links });
    const linked = pdfLinks.length ? this.applyLinks(pdfLinks.map((x) => ({ key: itemKey(x.name), name: x.name, urls: x.links }))) : 0;
    this.save();
    this.queueMissingPhotos();
    return { type: parsed.type, added, skipped, date: parsed.date, photos, linked };
  }

  // ---- dividing orders between the two packers --------------------------

  // Sets order.assigned to 0, 1 or null (= either packer) from state.split.
  assignOrders() {
    const { mode, prefixes } = this.state.split;
    const orders = this.state.day.orders;
    if (mode === 'half') {
      // Split by number of units so both packers get about the same work.
      const units = orders.reduce((a, o) => a + o.lines.reduce((b, l) => b + l.qty, 0), 0);
      let run = 0;
      for (const o of orders) {
        const u = o.lines.reduce((b, l) => b + l.qty, 0);
        o.assigned = run + u / 2 <= units / 2 ? 0 : 1;
        run += u;
      }
    } else if (mode === 'prefix') {
      for (const o of orders) {
        const p = refPrefix(o.ref);
        o.assigned = prefixes[p] === 0 || prefixes[p] === 1 ? prefixes[p] : null;
      }
    } else for (const o of orders) o.assigned = null;
  }

  // ---- listing photos (catalog from marketplace reports) ----------------

  addToCatalog(report, filename) {
    const seen = new Set(this.catalog.map((c) => c.key + '|' + c.image));
    let added = 0;
    for (const it of report.items) {
      const id = it.key + '|' + it.image;
      if (seen.has(id)) continue;
      seen.add(id);
      this.catalog.push(it);
      added++;
    }
    this.saveCatalog();
    const photos = this.autoPhotos();
    this.state.day.files.push({ name: filename, type: 'photos', added, at: Date.now() });
    this.save();
    return { source: report.source, rows: report.rows, withImage: report.items.length, added, columns: report.columns, photos };
  }

  saveCatalog() {
    fs.writeFileSync(this.catalogFile, JSON.stringify(this.catalog));
    const sources = {};
    for (const c of this.catalog) sources[c.source] = (sources[c.source] || 0) + 1;
    this.state.catalogInfo = { count: this.catalog.length, sources };
  }

  todaysProducts() {
    const map = new Map();
    for (const t of this.state.day.totals) map.set(t.key, t.name);
    for (const o of this.state.day.orders) for (const l of o.lines) if (!map.has(l.key)) map.set(l.key, l.name);
    return [...map].map(([key, name]) => ({ key, name }));
  }

  // Products whose name is exactly a listing title get that photo right away.
  // Anything less certain is only suggested (see suggestions()).
  autoPhotos() {
    if (!this.catalog.length) return 0;
    const byKey = new Map();
    for (const c of this.catalog) if (!byKey.has(c.key)) byKey.set(c.key, c);
    let n = 0;
    for (const p of this.todaysProducts()) {
      const c = byKey.get(p.key);
      if (c && !this.state.images[p.key]) {
        this.setImage(p.key, c.image, { source: c.source, title: c.title });
        n++;
      }
    }
    return n;
  }

  // Today's products ranked by how well they match a listing title.
  matchProducts(title) {
    return this.todaysProducts()
      .map((p) => ({ ...p, score: matchScore(p.name, title), hasPhoto: !!this.state.images[p.key] }))
      .sort((a, b) => b.score - a.score || a.hasPhoto - b.hasPhoto || a.name.localeCompare(b.name));
  }

  suggestions() {
    return this.todaysProducts()
      .filter((p) => !this.state.images[p.key])
      .map((p) => ({ ...p, candidates: bestMatches(p.name, this.catalog) }))
      .filter((p) => p.candidates.length)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- listing links from the back office ---------------------------------

  // rows: [{ref, name, links:[{url, kind}]}] from a links spreadsheet.
  importLinks(rows, filename) {
    const day = this.state.day;
    const products = this.todaysProducts();
    const byKey = new Map(products.map((p) => [p.key, p]));
    const refSeen = {};
    const entries = [];
    const unmatched = [];
    for (const row of rows) {
      let key = null;
      let name = row.name;
      const order = row.ref ? day.orders.find((o) => o.ref.toUpperCase() === row.ref) : null;
      if (order) {
        if (name) {
          // Name given too: pick the matching item of that order.
          const best = order.lines.map((l) => ({ l, s: l.key === itemKey(name) ? 2 : matchScore(name, l.name) })).sort((a, b) => b.s - a.s)[0];
          if (best && best.s >= 0.6) ({ key, name } = best.l);
        }
        if (!key) {
          // Several rows for one multi-item order go to its items in order.
          const i = (refSeen[order.ref] = (refSeen[order.ref] ?? -1) + 1);
          const l = order.lines[Math.min(i, order.lines.length - 1)];
          ({ key, name } = l);
        }
      } else if (name) {
        key = itemKey(name);
        if (!byKey.has(key)) {
          // Small spelling differences: accept a near-certain match to today's products.
          const best = products.map((p) => ({ p, s: matchScore(name, p.name) })).sort((a, b) => b.s - a.s)[0];
          if (best && best.s >= 0.95 && matchScore(best.p.name, name) >= 0.95) ({ key, name } = best.p);
        }
      }
      if (!key) {
        unmatched.push(row.ref || row.name);
        continue;
      }
      entries.push({ key, name, urls: row.links.map((l) => l.url) });
    }
    const linked = this.applyLinks(entries);
    const today = new Set(products.map((p) => p.key));
    day.files.push({ name: filename, type: 'links', added: linked, at: Date.now() });
    this.save();
    this.queueMissingPhotos();
    return {
      rows: rows.length,
      linked,
      today: entries.filter((e) => today.has(e.key)).length,
      unmatched,
    };
  }

  // entries: [{key, name, urls}] — newest links replace older ones for a product.
  applyLinks(entries) {
    const merged = new Map();
    for (const e of entries) {
      const m = merged.get(e.key) || { name: e.name, urls: [] };
      for (const u of e.urls) if (!m.urls.includes(u)) m.urls.push(u);
      merged.set(e.key, m);
    }
    for (const [key, { name, urls }] of merged) {
      const list = urls.map((url) => ({ url, kind: classify(url) })).filter((l) => l.kind);
      if (!list.length) continue;
      this.state.links[key] = list;
      this.linkNames = this.linkNames || {};
      this.linkNames[key] = name;
      const direct = list.find((l) => l.kind === 'image');
      const meta = this.state.imageMeta[key];
      if (direct) {
        if (this.state.images[key] !== direct.url) this.setImage(key, direct.url, { source: 'Back office', title: name, via: 'links', link: direct.url });
        delete this.state.photoJobs.failed[key];
      } else if (meta && meta.via === 'links' && !list.some((l) => l.url === meta.link)) {
        // The back office changed the listing: fetch the new photo.
        this.removeImage(key);
        delete this.state.photoJobs.failed[key];
      }
    }
    return merged.size;
  }

  // Queue a photo fetch for every product (today's first) that has listing links but no photo.
  queueMissingPhotos() {
    const today = this.todaysProducts().map((p) => p.key);
    const keys = [...new Set([...today, ...Object.keys(this.state.links)])];
    for (const key of keys)
      if (this.state.links[key] && !this.state.images[key] && !this.state.photoJobs.failed[key] && !this.queue.includes(key)) this.queue.push(key);
    this.pump();
  }

  retryPhoto(key) {
    delete this.state.photoJobs.failed[key];
    if (!this.queue.includes(key)) this.queue.unshift(key);
    this.pump();
  }

  pump() {
    while (this.running < 2 && this.queue.length) {
      const key = this.queue.shift();
      this.running++;
      this.fetchPhoto(key).finally(() => {
        this.running--;
        this.pump();
        if (!this.running && !this.queue.length) this.updatePending(true);
      });
    }
    this.updatePending(false);
  }

  updatePending(save) {
    const pending = this.queue.length + this.running;
    if (pending !== this.state.photoJobs.pending || save) {
      this.state.photoJobs.pending = pending;
      this.save();
    }
  }

  async fetchPhoto(key) {
    const links = (this.state.links[key] || [])
      .filter((l) => l.kind !== 'image')
      .sort((a, b) => FETCH_ORDER.indexOf(a.kind) - FETCH_ORDER.indexOf(b.kind));
    const errors = [];
    for (const l of links) {
      try {
        const image = await this.fetcher(l.url);
        if (!this.state.links[key]) return; // links were cleared meanwhile
        this.setImage(key, image, { source: SOURCE_NAME[l.kind], title: l.url, via: 'links', link: l.url });
        delete this.state.photoJobs.failed[key];
        this.save();
        return;
      } catch (e) {
        errors.push(`${SOURCE_NAME[l.kind]}: ${e.message}`);
      }
    }
    const name = this.todaysProducts().find((p) => p.key === key)?.name || this.linkNames?.[key] || key;
    this.state.photoJobs.failed[key] = { name, errors, at: Date.now() };
    this.save();
  }

  fetcher(url) {
    return fetchListingImage(url);
  }

  setImage(key, url, meta = null) {
    this.removeImage(key);
    this.state.images[key] = url;
    if (meta) this.state.imageMeta[key] = meta;
  }

  // ---- helpers ---------------------------------------------------------

  findLine(id) {
    for (const o of this.state.day.orders) {
      const l = o.lines.find((x) => x.id === id);
      if (l) return { order: o, line: l };
    }
    return {};
  }

  isOpen(order) {
    return order.lines.some((l) => !l.status);
  }

  // The order this packer is working on, claiming the next free one if needed.
  // Packers take their own share first; with help=true they then take the
  // other packer's orders from the end of the list (so they don't collide).
  claimNext(packer, help = false) {
    const orders = this.state.day.orders;
    const free = (o) => o.claimedBy == null && this.isOpen(o);
    let mine = orders.find((o) => o.claimedBy === packer && this.isOpen(o));
    if (!mine) mine = orders.find((o) => free(o) && (o.assigned == null || o.assigned === packer));
    if (!mine && help) mine = [...orders].reverse().find(free);
    if (mine) mine.claimedBy = packer;
    return mine || null;
  }

  // ---- actions ---------------------------------------------------------

  act(a) {
    const day = this.state.day;
    const packer = Number.isInteger(a.packer) ? a.packer : null;
    switch (a.type) {
      case 'claim': {
        this.claimNext(packer, a.help);
        break;
      }
      case 'mark': {
        // status: 'packed' | 'missing' | null
        const { order, line } = this.findLine(a.id);
        if (!line) throw new Error('Unknown item');
        line.status = a.status || null;
        line.by = a.status ? packer : null;
        line.at = a.status ? Date.now() : null;
        if (packer != null) order.claimedBy = packer;
        if (!this.isOpen(order)) this.claimNext(packer, a.help);
        break;
      }
      case 'undo': {
        // Re-open the most recent item this packer resolved.
        let last = null;
        for (const o of day.orders)
          for (const l of o.lines)
            if (l.by === packer && l.status && (!last || l.at > last.line.at)) last = { order: o, line: l };
        if (!last) throw new Error('Nothing to undo');
        // Hand back any order this packer had started claiming meanwhile.
        for (const o of day.orders)
          if (o !== last.order && o.claimedBy === packer && o.lines.every((l) => !l.status)) o.claimedBy = null;
        last.line.status = null;
        last.line.by = null;
        last.line.at = null;
        last.order.claimedBy = packer;
        break;
      }
      case 'release': {
        // Put an order back in the queue (e.g. packer goes on break).
        for (const o of day.orders) if (o.claimedBy === packer && this.isOpen(o)) o.claimedBy = null;
        break;
      }
      case 'reopenOrder': {
        const o = day.orders.find((x) => x.ref === a.ref);
        if (!o) throw new Error('Unknown order');
        for (const l of o.lines) if (l.status === 'missing') Object.assign(l, { status: null, by: null, at: null });
        o.claimedBy = null;
        break;
      }
      case 'resetOrder': {
        const o = day.orders.find((x) => x.ref === a.ref);
        if (!o) throw new Error('Unknown order');
        for (const l of o.lines) Object.assign(l, { status: null, by: null, at: null });
        o.claimedBy = null;
        break;
      }
      case 'reopenBought': {
        // Items the shoppers brought back: put those orders back into the queue.
        for (const o of day.orders) {
          let touched = false;
          for (const l of o.lines) {
            const s = day.stock[l.key];
            if (l.status === 'missing' && s && s.status === 'bought') {
              Object.assign(l, { status: null, by: null, at: null });
              touched = true;
            }
          }
          if (touched && o.claimedBy !== packer) o.claimedBy = null;
        }
        break;
      }
      case 'stock': {
        // status: 'have' | 'missing' | 'bought' | null
        if (!a.key) throw new Error('Missing key');
        if (!a.status) delete day.stock[a.key];
        else {
          const prev = day.stock[a.key] || {};
          day.stock[a.key] = {
            status: a.status,
            need: a.need != null ? Math.max(1, a.need | 0) : prev.need ?? null,
            by: packer,
            at: Date.now(),
          };
        }
        break;
      }
      case 'account': {
        const prefix = String(a.prefix || '').toUpperCase().replace(/[^A-Z]/g, '');
        if (!prefix) throw new Error('Missing Ref letters');
        const name = String(a.name ?? '').trim().slice(0, 40);
        const color = /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : this.state.accounts[prefix]?.color || '#475569';
        if (name) this.state.accounts[prefix] = { name, color };
        else delete this.state.accounts[prefix];
        break;
      }
      case 'packers': {
        if (Array.isArray(a.names) && a.names.length === 2)
          this.state.packers = a.names.map((n, i) => String(n || '').trim().slice(0, 30) || `Packer ${i + 1}`);
        break;
      }
      case 'imageUrl': {
        if (!a.key) throw new Error('Missing key');
        if (a.url) {
          if (!/^https?:\/\//i.test(a.url)) throw new Error('Image link must start with http:// or https://');
          this.setImage(a.key, a.url, a.source ? { source: String(a.source), title: String(a.title || ''), link: a.link ? String(a.link) : undefined } : null);
        } else this.removeImage(a.key);
        break;
      }
      case 'setListing': {
        // Sent from the back office's browser while looking at the listing
        // ("Send to Packing App" button): its photo + link for one product.
        const key = a.key || (a.name ? itemKey(a.name) : null);
        if (!key) throw new Error('Choose a product');
        if (!/^https?:\/\//i.test(a.image || '')) throw new Error('No photo address');
        const kind = classifyUrlKind(a.link || '') || 'other';
        this.setImage(key, String(a.image), { source: SOURCE_NAME[kind] || 'Listing', title: String(a.title || ''), link: a.link ? String(a.link) : undefined, via: 'browser' });
        if (a.link && /^https?:\/\//i.test(a.link))
          this.state.links[key] = [...(this.state.links[key] || []).filter((l) => l.url !== a.link && l.kind !== kind), { url: String(a.link), kind }];
        delete this.state.photoJobs.failed[key];
        break;
      }
      case 'split': {
        const mode = ['shared', 'half', 'prefix'].includes(a.mode) ? a.mode : this.state.split.mode;
        const prefixes = { ...this.state.split.prefixes };
        if (a.prefix) {
          if (a.to === 0 || a.to === 1) prefixes[a.prefix] = a.to;
          else delete prefixes[a.prefix];
        }
        this.state.split = { mode, prefixes };
        this.assignOrders();
        // Hand back orders nobody has started that now belong to the other packer.
        for (const o of day.orders)
          if (o.claimedBy != null && o.assigned != null && o.assigned !== o.claimedBy && o.lines.every((l) => !l.status)) o.claimedBy = null;
        break;
      }
      case 'retryPhoto': {
        if (!a.key) throw new Error('Missing key');
        this.retryPhoto(a.key);
        break;
      }
      case 'retryAllPhotos': {
        this.state.photoJobs.failed = {};
        this.queueMissingPhotos();
        break;
      }
      case 'clearCatalog': {
        this.catalog = [];
        this.saveCatalog();
        break;
      }
      case 'newDay': {
        this.state.day = EMPTY_DAY();
        break;
      }
      default:
        throw new Error('Unknown action ' + a.type);
    }
    this.save();
  }

  saveImage(key, buffer) {
    const name = `${key.replace(/[^a-z0-9]+/g, '-').slice(0, 80)}-${Date.now()}.jpg`;
    fs.writeFileSync(path.join(this.imageDir, name), buffer);
    this.setImage(key, `/images/${name}`, { source: 'Photo', title: '' });
    this.save();
  }

  removeImage(key) {
    const old = this.state.images[key];
    if (old && old.startsWith('/images/')) {
      fs.rm(path.join(this.imageDir, path.basename(old)), { force: true }, () => {});
    }
    delete this.state.images[key];
    delete this.state.imageMeta[key];
  }
}

// "WS17" -> "WS", "C66" -> "C"
function classify(url) {
  try {
    return /^https?:$/.test(new URL(url).protocol) ? classifyUrlKind(url) : null;
  } catch {
    return null;
  }
}

export function refPrefix(ref) {
  return (String(ref).match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
}
