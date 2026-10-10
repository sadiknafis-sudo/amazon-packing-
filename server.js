// Packing app server. Run `npm start`, then open the printed address on each
// tablet/phone connected to the same Wi-Fi.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePdf } from './lib/parse.js';
import { Store } from './lib/store.js';
import crypto from 'node:crypto';
import { parseReport, parseSpreadsheet } from './lib/catalog.js';
import { fetchListingImage, classifyUrl, SOURCE_NAME } from './lib/listing.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 25 * 1024 * 1024;
// Optional PIN for the whole app — set it when the back office reaches the
// app over the internet: ACCESS_PIN=1234 npm start
const ACCESS_PIN = process.env.ACCESS_PIN || '';
const PIN_TOKEN = ACCESS_PIN && crypto.createHash('sha256').update('packing:' + ACCESS_PIN).digest('hex');

const store = new Store(DATA_DIR);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('File too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveFile(res, dir, rel) {
  const file = path.join(dir, path.normalize(rel).replace(/^([.][.][/\\])+/, ''));
  if (!file.startsWith(dir + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': dir === PUBLIC_DIR ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/api/login') {
      const { pin } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!ACCESS_PIN || String(pin) === ACCESS_PIN) {
        res.setHeader('Set-Cookie', `pin=${PIN_TOKEN}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
        return send(res, 200, { ok: true });
      }
      return send(res, 401, { error: 'Wrong PIN' });
    }
    if (ACCESS_PIN && (p.startsWith('/api/') || p.startsWith('/images/'))) {
      const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('pin='));
      if (!cookie || cookie.slice(4) !== PIN_TOKEN) return send(res, 401, { error: 'PIN required', pin: true });
    }

    if (req.method === 'GET' && p === '/api/state') return send(res, 200, store.state);

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      const push = (state) => res.write(`data: ${JSON.stringify(state)}\n\n`);
      push(store.state);
      const off = store.subscribe(push);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        off();
        clearInterval(ping);
      });
      return;
    }

    if (req.method === 'POST' && p === '/api/action') {
      const action = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      store.act(action);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/import') {
      const buf = await readBody(req);
      const filename = decodeURIComponent(req.headers['x-filename'] || 'upload.pdf');
      let parsed;
      try {
        parsed = await parsePdf(buf);
      } catch (e) {
        return send(res, 400, { error: `Could not read ${filename} as a PDF` });
      }
      if (parsed.type === 'unknown')
        return send(res, 400, { error: `${filename}: not a "Packing Sheet" or "Total Items Pick List" PDF` });
      return send(res, 200, store.importParsed(parsed, filename));
    }

    if (req.method === 'POST' && p === '/api/catalog') {
      const buf = await readBody(req);
      const filename = decodeURIComponent(req.headers['x-filename'] || 'report.csv');
      let report;
      try {
        report = await parseReport(buf, filename);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      return send(res, 200, store.addToCatalog(report, filename));
    }

    if (req.method === 'POST' && p === '/api/upload') {
      // Back-office upload: packing sheets, total list, links files and
      // listing reports in any mix — each file is recognised automatically.
      const buf = await readBody(req);
      const filename = decodeURIComponent(req.headers['x-filename'] || 'upload');
      if (buf.subarray(0, 5).toString() === '%PDF-') {
        let parsed;
        try {
          parsed = await parsePdf(buf);
        } catch {
          return send(res, 400, { error: `Could not read ${filename} as a PDF` });
        }
        if (parsed.type === 'unknown') return send(res, 400, { error: `${filename}: not a "Packing Sheet" or "Total Items Pick List" PDF` });
        return send(res, 200, { kind: parsed.type, ...store.importParsed(parsed, filename) });
      }
      let sheet;
      try {
        sheet = await parseSpreadsheet(buf, filename);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      if (sheet.kind === 'links') return send(res, 200, { kind: 'links', ...store.importLinks(sheet.rows, filename) });
      return send(res, 200, { kind: 'catalog', ...store.addToCatalog(sheet.report, filename) });
    }

    if (req.method === 'GET' && p === '/api/suggestions') return send(res, 200, store.suggestions());
    if (req.method === 'GET' && p === '/api/match') return send(res, 200, store.matchProducts(url.searchParams.get('title') || ''));

    if (req.method === 'POST' && p === '/api/listing-photo') {
      // Paste an Amazon / Walmart / eBay listing link -> use its main photo.
      const { key, url: link } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!key || !/^https?:\/\//i.test(link || '')) return send(res, 400, { error: 'Paste a full link starting with https://' });
      let image;
      try {
        image = await fetchListingImage(link);
      } catch (e) {
        return send(res, 400, {
          error: `Could not get the photo from that page: ${e.message}. Open the listing, long-press / right-click the main photo, choose "Copy image address" and paste that instead.`,
        });
      }
      const kind = classifyUrl(link);
      store.state.links[key] = [...(store.state.links[key] || []).filter((l) => l.url !== link), { url: link, kind }];
      store.act({ type: 'imageUrl', key, url: image, source: SOURCE_NAME[kind] || new URL(link).hostname, title: link, link });
      return send(res, 200, { ok: true, image });
    }

    if (req.method === 'POST' && p === '/api/image') {
      const key = url.searchParams.get('key');
      if (!key) return send(res, 400, { error: 'Missing key' });
      const buf = await readBody(req);
      if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return send(res, 400, { error: 'Expected a JPEG' });
      store.saveImage(key, buf);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p.startsWith('/images/')) return serveFile(res, store.imageDir, p.slice(8));
    if (req.method === 'GET') return serveFile(res, PUBLIC_DIR, p === '/' ? 'index.html' : p.slice(1));
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\nPacking app running.\n  On this computer:  http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces()))
    for (const n of nets || [])
      if (n.family === 'IPv4' && !n.internal) console.log(`  On tablets/phones: http://${n.address}:${PORT}`);
  console.log('');
});
