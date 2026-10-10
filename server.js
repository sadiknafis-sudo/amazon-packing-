// Packing app server. Run `npm start`, then open the printed address on each
// tablet/phone connected to the same Wi-Fi.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePdf } from './lib/parse.js';
import { Store } from './lib/store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 25 * 1024 * 1024;

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
