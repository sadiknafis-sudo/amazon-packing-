// Listing photos from marketplace reports (Amazon, Walmart, eBay ...).
// Any CSV / TSV / TXT / XLSX report that has a product title column and an
// image link column can be imported. Rows are kept in a catalog so that
// products on future packing sheets get their photo automatically.
import { readSheet } from 'read-excel-file/node';
import { itemKey } from './parse.js';

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

async function readRows(buffer, filename) {
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b; // .xlsx files are zip archives
  if (isZip || /\.xlsx$/i.test(filename)) {
    const rows = await readSheet(buffer);
    return rows.map((r) => r.map((c) => (c == null ? '' : String(c))));
  }
  if (/\.xls$/i.test(filename)) throw new Error('Old .xls files are not supported — open it and "Save as" .xlsx or .csv');
  return parseDelimited(buffer.toString('utf8'));
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

// Pulls the main product photo out of a listing page's HTML.
export function imageFromListingHtml(html) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? m[1].replace(/&amp;/g, '&').replace(/\\u002F/g, '/') : null;
  };
  return (
    pick(/data-old-hires="(https:[^"]+)"/) || // Amazon main image
    pick(/"hiRes":"(https:[^"]+)"/) ||
    pick(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
    pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/id="landingImage"[^>]+src="(https:[^"]+)"/)
  );
}
