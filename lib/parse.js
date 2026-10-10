// Parses the two PDF reports the store system prints:
//   * "Packing Sheet"          -> orders (Ref, Item Name, Qty, Recipient Name)
//   * "Total Items Pick List"  -> totals (Product, Qty)
// The parser works from text positions, so wrapped item names and orders with
// several items (extra rows without a Ref) are handled.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}(\s+\d{1,2}:\d{2}(:\d{2})?)?$/;

export function itemKey(name) {
  return String(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function readPages(buffer) {
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data, verbosity: 0, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // Clickable links in the PDF (e.g. the item name linked to its listing).
    const linkRects = (await page.getAnnotations())
      .filter((a) => a.subtype === 'Link' && /^https?:\/\//i.test(a.url || a.unsafeUrl || ''))
      .map((a) => ({ url: a.url || a.unsafeUrl, r: a.rect }));
    pages.push(
      tc.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => {
          const x = it.transform[4];
          const y = it.transform[5];
          const hit = linkRects.find(({ r }) => x + 2 >= r[0] && x + 2 <= r[2] && y + 2 >= r[1] && y <= r[3]);
          return { str: it.str.trim(), x, y, link: hit ? hit.url : null };
        })
    );
  }
  await doc.destroy();
  return pages;
}

// Removes the "10/09/2026 12:32:22 ... 1" footer line and returns the date seen.
function stripFooter(items) {
  const footer = items.find((it) => DATE_RE.test(it.str));
  if (!footer) return { items, date: null };
  return {
    items: items.filter((it) => Math.abs(it.y - footer.y) > 2),
    date: footer.str.split(/\s+/)[0],
  };
}

function findHeader(items, label) {
  return items.find((it) => it.str.toLowerCase() === label.toLowerCase());
}

// Groups name-column fragments into blocks (one block = one item name, possibly
// wrapped onto several lines) and pairs each block with its quantity.
function buildLines(nameItems, qtyItems) {
  const names = [...nameItems].sort((a, b) => b.y - a.y);
  const blocks = [];
  for (const n of names) {
    const last = blocks[blocks.length - 1];
    // Wrapped lines sit ~11pt apart; separate rows are ~19pt+ apart.
    if (last && last.minY - n.y <= 13) {
      last.parts.push(n.str);
      last.minY = n.y;
      if (n.link && !last.links.includes(n.link)) last.links.push(n.link);
    } else {
      blocks.push({ parts: [n.str], maxY: n.y, minY: n.y, links: n.link ? [n.link] : [] });
    }
  }
  const lines = [];
  for (const q of qtyItems) {
    const qty = parseInt(q.str, 10);
    if (!Number.isFinite(qty)) continue;
    let best = null;
    let bestDist = Infinity;
    for (const b of blocks) {
      if (b.used) continue;
      const mid = (b.maxY + b.minY) / 2;
      const inside = q.y <= b.maxY + 3 && q.y >= b.minY - 3;
      const d = Math.abs(mid - q.y);
      if (inside && d < bestDist) {
        best = b;
        bestDist = d;
      }
    }
    if (!best) continue;
    best.used = true;
    lines.push({ name: best.parts.join(' ').replace(/\s+/g, ' ').trim(), qty, y: q.y, top: best.maxY, links: best.links });
  }
  return lines.sort((a, b) => b.top - a.top);
}

function parsePackingPage(rawItems) {
  const { items, date } = stripFooter(rawItems);
  const hRef = findHeader(items, 'Ref');
  const hName = findHeader(items, 'Item Name');
  const hQty = findHeader(items, 'Qty');
  const hRec = findHeader(items, 'Recipient Name');
  if (!hRef || !hName || !hQty || !hRec) return { rows: [], date };
  const body = items.filter((it) => it.y < hRef.y - 2);
  const nameEnd = hQty.x - 8;
  const qtyEnd = hRec.x - 8;
  const refs = body.filter((it) => it.x < hName.x - 5);
  const names = body.filter((it) => it.x >= hName.x - 5 && it.x < nameEnd);
  const qtys = body.filter((it) => it.x >= nameEnd && it.x < qtyEnd);
  const recs = body.filter((it) => it.x >= qtyEnd);

  const lines = buildLines(names, qtys);
  const rows = lines.map((l) => {
    const near = (arr) => arr.find((it) => Math.abs(it.y - l.y) <= 3);
    const ref = near(refs);
    const rec = near(recs);
    // Links anywhere on the row (item name, ref or an extra link column) belong to this item.
    const rowLinks = body.filter((it) => it.link && it.y <= l.top + 3 && it.y >= l.y - 12).map((it) => it.link);
    const links = [...new Set([...l.links, ...rowLinks])];
    return { ref: ref ? ref.str : null, recipient: rec ? rec.str : null, name: l.name, qty: l.qty, links };
  });
  return { rows, date };
}

function parseTotalPage(rawItems) {
  const { items, date } = stripFooter(rawItems);
  const hProd = findHeader(items, 'Product');
  const hQty = findHeader(items, 'Qty');
  if (!hProd || !hQty) return { rows: [], date };
  const body = items.filter((it) => it.y < hProd.y - 2);
  const qtyStart = hQty.x - 10;
  const names = body.filter((it) => it.x < qtyStart);
  const qtys = body.filter((it) => it.x >= qtyStart);
  return { rows: buildLines(names, qtys).map(({ name, qty, links }) => ({ name, qty, links })), date };
}

export async function parsePdf(buffer) {
  const pages = await readPages(buffer);
  const allText = pages.flat().map((it) => it.str).join(' ');

  if (/Packing Sheet/i.test(allText)) {
    const orders = [];
    let date = null;
    for (const page of pages) {
      const res = parsePackingPage(page);
      date = date || res.date;
      for (const row of res.rows) {
        const line = { name: row.name, qty: row.qty, links: row.links };
        if (row.ref) {
          const recipient = (row.recipient || '').replace(new RegExp(`\\s*\\(${row.ref}\\)\\s*$`), '').trim();
          orders.push({ ref: row.ref, recipient, lines: [line] });
        } else if (orders.length) {
          // Extra item for the previous order (may continue from previous page).
          orders[orders.length - 1].lines.push(line);
        }
      }
    }
    return { type: 'sheet', date, orders };
  }

  if (/Total Items/i.test(allText)) {
    const totals = [];
    let date = null;
    for (const page of pages) {
      const res = parseTotalPage(page);
      date = date || res.date;
      totals.push(...res.rows);
    }
    return { type: 'totals', date, totals };
  }

  return { type: 'unknown' };
}
