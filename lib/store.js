// In-memory state + JSON persistence + all the actions packers can take.
// Everything runs on Node's single thread, so each action is atomic: two
// packers can never claim the same order.
import fs from 'node:fs';
import path from 'node:path';
import { itemKey } from './parse.js';
import { bestMatches } from './catalog.js';

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
      catalogInfo: { count: 0, sources: {} },
      day: EMPTY_DAY(),
    };
    if (fs.existsSync(this.file)) {
      try {
        Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, 'utf8')));
      } catch (e) {
        console.error('Could not read saved state, starting fresh:', e.message);
      }
    }
    this.catalogFile = path.join(dataDir, 'catalog.json');
    this.catalog = fs.existsSync(this.catalogFile) ? JSON.parse(fs.readFileSync(this.catalogFile, 'utf8')) : [];
    this.listeners = new Set();
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
    this.save();
    return { type: parsed.type, added, skipped, date: parsed.date, photos };
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

  suggestions() {
    return this.todaysProducts()
      .filter((p) => !this.state.images[p.key])
      .map((p) => ({ ...p, candidates: bestMatches(p.name, this.catalog) }))
      .filter((p) => p.candidates.length)
      .sort((a, b) => a.name.localeCompare(b.name));
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
      case 'packers': {
        if (Array.isArray(a.names) && a.names.length === 2)
          this.state.packers = a.names.map((n, i) => String(n || '').trim().slice(0, 30) || `Packer ${i + 1}`);
        break;
      }
      case 'imageUrl': {
        if (!a.key) throw new Error('Missing key');
        if (a.url) {
          if (!/^https?:\/\//i.test(a.url)) throw new Error('Image link must start with http:// or https://');
          this.setImage(a.key, a.url, a.source ? { source: String(a.source), title: String(a.title || '') } : null);
        } else this.removeImage(a.key);
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
export function refPrefix(ref) {
  return (String(ref).match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
}
