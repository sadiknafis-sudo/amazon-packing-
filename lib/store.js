// In-memory state + JSON persistence + all the actions packers can take.
// Everything runs on Node's single thread, so each action is atomic: two
// packers can never claim the same order.
import fs from 'node:fs';
import path from 'node:path';
import { itemKey } from './parse.js';

const EMPTY_DAY = () => ({
  label: null,
  files: [],
  totals: [], // [{key, name, qty}] from the Total Items Pick List
  orders: [], // [{ref, recipient, claimedBy, lines:[{id, key, name, qty, status, by, at}]}]
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
      day: EMPTY_DAY(),
    };
    if (fs.existsSync(this.file)) {
      try {
        Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, 'utf8')));
      } catch (e) {
        console.error('Could not read saved state, starting fresh:', e.message);
      }
    }
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
    this.save();
    return { type: parsed.type, added, skipped, date: parsed.date };
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
  claimNext(packer) {
    const orders = this.state.day.orders;
    let mine = orders.find((o) => o.claimedBy === packer && this.isOpen(o));
    if (!mine) {
      mine = orders.find((o) => o.claimedBy == null && this.isOpen(o));
      if (mine) mine.claimedBy = packer;
    }
    return mine || null;
  }

  // ---- actions ---------------------------------------------------------

  act(a) {
    const day = this.state.day;
    const packer = Number.isInteger(a.packer) ? a.packer : null;
    switch (a.type) {
      case 'claim': {
        this.claimNext(packer);
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
        if (!this.isOpen(order)) this.claimNext(packer);
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
          this.state.images[a.key] = a.url;
        } else this.removeImage(a.key);
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
    this.removeImage(key);
    fs.writeFileSync(path.join(this.imageDir, name), buffer);
    this.state.images[key] = `/images/${name}`;
    this.save();
  }

  removeImage(key) {
    const old = this.state.images[key];
    if (old && old.startsWith('/images/')) {
      fs.rm(path.join(this.imageDir, path.basename(old)), { force: true }, () => {});
    }
    delete this.state.images[key];
  }
}
