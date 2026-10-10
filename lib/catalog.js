// Listing photos from marketplace reports (Amazon, Walmart, eBay ...).
// Any CSV / TSV / TXT / XLSX report that has a product title column and an
// image link column can be imported. Rows are kept in a catalog so that
// products on future packing sheets get their photo automatically.
import { readSheet } from 'read-excel-file/node';
import { unzipSync, strFromU8 } from 'fflate';
import { itemKey } from './parse.js';
import { classifyUrl } from './listing.js';

const TITLE_COLS = [
  'item-name', 'item name', 'product-name', 'product name', 'title', 'item title', 'product title',
  'listing title', 'name', 'product', 'item', 'product description', 'description',
];
const IMAGE_COL_RE = /image|picture|pic.?url|photo|img/i;
const ID_COLS = {
  sku: ['seller-sku', 'sku', 'seller sku', 'custom label (sku)', 'custom label', 'partner sku'],
  asin: ['asin1', 'asin', 'product-id'],
  itemId: ['item id', 'item number', 'itemid', 'listing-id', 'listing id', 'walmart item id', 'item_id'],
};

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[_]+/g, ' ');

// --- file reading ---------------------------------------------------------

function parseDelimited(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = (firstLine.match(/\t/g) || []).length >= (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// Returns { rows, links } where links maps "row,col" -> URL for cells that are
// Excel hyperlinks (a product name you can click, or =HYPERLINK(...)).
async function readTable(buffer, filename) {
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b; // .xlsx files are zip archives
  if (isZip || /\.xlsx$/i.test(filename)) {
    const rows = (await readSheet(buffer)).map((r) => r.map((c) => (c == null ? '' : String(c))));
    let links = new Map();
    try {
      links = xlsxHyperlinks(buffer);
    } catch {
      // hyperlinks are a bonus; the cell text is still there
    }
    return { rows, links };
  }
  if (/\.xls$/i.test(filename)) throw new Error('Old .xls files are not supported — open it and "Save as" .xlsx or .csv');
  return { rows: parseDelimited(buffer.toString('utf8')), links: new Map() };
}

async function readRows(buffer, filename) {
  return (await readTable(buffer, filename)).rows;
}

const xmlDecode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

function cellPos(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return `${Number(m[2]) - 1},${col - 1}`;
}

function xlsxHyperlinks(buffer) {
  const zip = unzipSync(new Uint8Array(buffer), { filter: (f) => f.name.startsWith('xl/') });
  const read = (name) => (zip[name] ? strFromU8(zip[name]) : '');
  // First sheet, as Excel orders them.
  const wb = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  const firstId = (wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/) || [])[1];
  let target = firstId && (rels.match(new RegExp(`<Relationship\\b[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstId}"`)) || [])[1];
  target = target ? 'xl/' + target.replace(/^\/?xl\//, '').replace(/^\//, '') : 'xl/worksheets/sheet1.xml';
  const sheet = read(target);
  const sheetRels = read(target.replace(/([^/]+)$/, '_rels/$1.rels'));
  const relTarget = {};
  for (const m of sheetRels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = (m[0].match(/\bId="([^"]+)"/) || [])[1];
    const t = (m[0].match(/\bTarget="([^"]+)"/) || [])[1];
    if (id && t) relTarget[id] = xmlDecode(t);
  }
  const links = new Map();
  for (const m of sheet.matchAll(/<hyperlink\b[^>]*>/g)) {
    const ref = (m[0].match(/\bref="([A-Z]+\d+)/) || [])[1];
    const id = (m[0].match(/\br:id="([^"]+)"/) || [])[1];
    const pos = ref && cellPos(ref);
    if (pos && id && relTarget[id]) links.set(pos, relTarget[id]);
  }
  for (const m of sheet.matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"[^>]*>\s*<f>([^<]*)<\/f>/g)) {
    const f = xmlDecode(m[2]).match(/HYPERLINK\(\s*"([^"]+)"/i);
    const pos = cellPos(m[1]);
    if (f && pos && !links.has(pos)) links.set(pos, f[1]);
  }
  return links;
}

// --- column detection -----------------------------------------------------

const looksLikeImageUrl = (v) => /^https?:\/\/\S+$/i.test(String(v).trim());

function pickColumn(header, names) {
  for (const n of names) {
    const i = header.findIndex((h) => norm(h) === n);
    if (i >= 0) return i;
  }
  return -1;
}

function detect(rows) {
  // The header row is the first row (of the first 15) that has a title column.
  for (let h = 0; h < Math.min(rows.length, 15); h++) {
    const header = rows[h];
    const title = pickColumn(header, TITLE_COLS);
    if (title < 0) continue;
    const body = rows.slice(h + 1, h + 200);
    // Image column: a header that mentions image/picture/photo with links in it.
    // The first such column ("main image", "image-url", "Primary Image URL") wins.
    let image = -1;
    let best = 0;
    header.forEach((col, i) => {
      if (!IMAGE_COL_RE.test(col)) return;
      const hits = body.filter((r) => looksLikeImageUrl(firstUrl(r[i]))).length;
      const score = hits + (/main|primary|^image.?url$|^picurl$/i.test(norm(col)) ? 0.5 : 0);
      if (hits && score > best) {
        best = score;
        image = i;
      }
    });
    const ids = Object.fromEntries(Object.entries(ID_COLS).map(([k, names]) => [k, pickColumn(header, names)]));
    return { headerRow: h, header, title, image, ids };
  }
  return null;
}

// Some reports put several links in one cell ("url1|url2" or "url1, url2").
function firstUrl(v) {
  const m = String(v ?? '').match(/https?:\/\/[^\s|,;"]+/i);
  return m ? m[0] : '';
}

export function guessSource(filename, header) {
  const s = `${filename} ${header.join(' ')}`.toLowerCase();
  if (/walmart/.test(s)) return 'Walmart';
  if (/ebay|custom label|picurl/.test(s)) return 'eBay';
  if (/amazon|asin|seller-sku|item-name/.test(s)) return 'Amazon';
  return 'Report';
}

export async function parseReport(buffer, filename) {
  const rows = await readRows(buffer, filename);
  const d = detect(rows);
  if (!d) throw new Error(`${filename}: could not find a product title column (looked for "item-name", "Product Name", "Title" …)`);
  if (d.image < 0)
    throw new Error(`${filename}: found the titles ("${d.header[d.title]}") but no column with image links. Download a report that includes image URLs.`);
  const source = guessSource(filename, d.header);
  const items = [];
  for (const r of rows.slice(d.headerRow + 1)) {
    const title = String(r[d.title] ?? '').trim();
    const image = firstUrl(r[d.image]);
    if (!title || !image) continue;
    const item = { title, key: itemKey(title), image, source };
    for (const [k, i] of Object.entries(d.ids)) if (i >= 0 && r[i]) item[k] = String(r[i]).trim();
    items.push(item);
  }
  return {
    source,
    items,
    columns: { title: d.header[d.title], image: d.header[d.image] },
    rows: rows.length - d.headerRow - 1,
  };
}

// --- links files from the back-office team ----------------------------------
// One row per product (or per order Ref) with any number of link columns:
//   Ref | Product | Amazon link | Walmart link | eBay link | Image link
// Link cells can hold the URL as text or be Excel hyperlinks; the product
// name itself can also be a hyperlink.

const REF_COLS = ['ref', 'ref #', 'ref no', 'reference', 'order ref', 'packing ref'];

function urlsIn(text) {
  return String(text ?? '').match(/https?:\/\/[^\s|,;"<>]+/gi) || [];
}

function readLinkRows(rows, links) {
  for (let h = 0; h < Math.min(rows.length, 15); h++) {
    const header = rows[h];
    const nameCol = pickColumn(header, TITLE_COLS);
    const refCol = pickColumn(header, REF_COLS);
    if (nameCol < 0 && refCol < 0) continue;
    const out = [];
    for (let r = h + 1; r < rows.length; r++) {
      const row = rows[r];
      const name = nameCol >= 0 ? String(row[nameCol] ?? '').trim() : '';
      const ref = refCol >= 0 ? String(row[refCol] ?? '').trim().toUpperCase() : '';
      const urls = [];
      row.forEach((cell, c) => {
        if (c === refCol) return;
        if (c !== nameCol) urls.push(...urlsIn(cell));
        const l = links.get(`${r},${c}`);
        if (l) urls.push(l);
      });
      const seen = new Set();
      const list = urls
        .map((u) => u.replace(/[.)\]]+$/, ''))
        .filter((u) => (seen.has(u) ? false : seen.add(u)))
        .map((url) => ({ url, kind: classifyUrl(url) }))
        .filter((l) => l.kind);
      if ((!name && !ref) || !list.length) continue;
      out.push({ ref: ref || null, name: urlsIn(name).length ? '' : name, links: list });
    }
    return { header, nameCol, refCol, rows: out };
  }
  return null;
}

// Decides whether a spreadsheet is a back-office links file or a marketplace
// listing report, and parses it accordingly.
export async function parseSpreadsheet(buffer, filename) {
  const { rows, links } = await readTable(buffer, filename);
  const lr = readLinkRows(rows, links);
  const hasListingLinks = lr && lr.rows.some((r) => r.links.some((l) => l.kind !== 'image'));
  const hasImageColumn = lr && lr.header.some((h) => IMAGE_COL_RE.test(h));
  if (lr && lr.rows.length && (hasListingLinks || lr.refCol >= 0 || !hasImageColumn)) return { kind: 'links', rows: lr.rows };
  return { kind: 'catalog', report: await parseReport(buffer, filename) };
}

// --- matching -------------------------------------------------------------

const STOP = new Set(['and', 'with', 'the', 'of', 'for', 'a', 'an', 'in', 'by', 'to', 'x', 'pack', 'count', 'ct', 'total', 'per', 'our', 'is', 'made']);
const UNIT = '(ml|l|g|gr|kg|oz|lb|lbs|ct|pcs|pc|caps|tablets|bags|rolls|count)';

export function tokens(name) {
  const s = String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/(\d)\s*[,.]\s*(\d)/g, '$1.$2')
    .replace(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT}\\b`, 'g'), ' $1$2 ')
    .replace(/'s\b/g, 's');
  return s.split(/[^a-z0-9.]+/).map((t) => t.replace(/^\.+|\.+$/g, '')).filter((t) => t && !STOP.has(t));
}

const isSize = (t) => new RegExp(`^\\d+(\\.\\d+)?${UNIT}$`).test(t);
const sizeVal = (t) => {
  const m = t.match(new RegExp(`^(\\d+(?:\\.\\d+)?)${UNIT}$`));
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = { kg: 1000, l: 1000, gr: 1, g: 1, ml: 1, oz: 28.35, lb: 453.6, lbs: 453.6 }[m[2]];
  return mult ? { n: n * mult, unit: ['l', 'ml'].includes(m[2]) ? 'vol' : 'w' } : { n, unit: m[2] };
};

// How well a marketplace listing title matches a product name from the
// packing sheet (0..1). Sizes must agree: "210g" never matches a "67g" listing.
export function matchScore(productName, listingTitle) {
  const a = tokens(productName);
  const b = new Set(tokens(listingTitle));
  if (!a.length || !b.size) return 0;
  const words = a.filter((t) => !isSize(t));
  const sizes = a.filter(isSize);
  const hit = words.filter((t) => b.has(t) || (t.length > 3 && [...b].some((x) => x.startsWith(t) || t.startsWith(x)))).length;
  let score = words.length ? (hit / words.length) ** 3 : 0; // every missing word (flavour, scent…) hurts
  if (sizes.length) {
    const bSizes = [...b].filter(isSize).map(sizeVal);
    const ok = sizes.map(sizeVal).some((s) => bSizes.some((x) => x.unit === s.unit && Math.abs(x.n - s.n) / s.n < 0.03));
    if (ok) score = Math.min(1, score + 0.1);
    else if (bSizes.length) score *= 0.4; // listing is a different size
    else score *= 0.85; // listing doesn't say a size
  }
  return Math.round(score * 100) / 100;
}

export function bestMatches(productName, catalog, limit = 4, min = 0.6) {
  const seen = new Set();
  return catalog
    .map((c) => ({ ...c, score: matchScore(productName, c.title) }))
    .filter((c) => c.score >= min)
    .sort((x, y) => y.score - x.score)
    .filter((c) => (seen.has(c.image) ? false : seen.add(c.image)))
    .slice(0, limit);
}

export { imageFromListingHtml } from './listing.js';
