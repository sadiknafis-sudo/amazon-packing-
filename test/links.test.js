import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpreadsheet } from '../lib/catalog.js';
import { classifyUrl, upgradeImage } from '../lib/listing.js';
import { Store } from '../lib/store.js';
import { itemKey } from '../lib/parse.js';

const fixture = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url));

test('recognises marketplace links and image links', () => {
  assert.equal(classifyUrl('https://www.amazon.ca/dp/B000'), 'amazon');
  assert.equal(classifyUrl('https://amzn.to/3abc'), 'amazon');
  assert.equal(classifyUrl('https://www.walmart.ca/en/ip/x/123'), 'walmart');
  assert.equal(classifyUrl('https://www.ebay.ca/itm/123'), 'ebay');
  assert.equal(classifyUrl('https://m.media-amazon.com/images/I/71a._AC_SL300_.jpg'), 'image');
  assert.equal(upgradeImage('https://i.ebayimg.com/images/g/abc/s-l500.jpg'), 'https://i.ebayimg.com/images/g/abc/s-l1600.jpg');
  assert.equal(upgradeImage('https://m.media-amazon.com/images/I/71a._AC_SL300_.jpg'), 'https://m.media-amazon.com/images/I/71a.jpg');
});

test('links file: text links, Excel hyperlinks on names and HYPERLINK() formulas', async () => {
  const r = await parseSpreadsheet(fixture('links-hyperlinks.xlsx'), 'links.xlsx');
  assert.equal(r.kind, 'links');
  assert.deepEqual(r.rows, [
    { ref: null, name: 'Dawn Orange 502ml', links: [{ url: 'https://www.amazon.ca/dp/B0001', kind: 'amazon' }] },
    {
      ref: null,
      name: 'KD Shaker 500g',
      links: [
        { url: 'https://www.ebay.ca/itm/123', kind: 'ebay' },
        { url: 'https://www.walmart.ca/ip/999', kind: 'walmart' },
      ],
    },
  ]);
});

test('links file (CSV) with Refs instead of names', async () => {
  const csv = 'Ref,Product,Amazon link,eBay link\nEB2,,,https://www.ebay.ca/itm/5\n,Fritos Corn Chips 340g,https://www.amazon.ca/dp/B9,\n';
  const r = await parseSpreadsheet(Buffer.from(csv), 'links.csv');
  assert.equal(r.kind, 'links');
  assert.equal(r.rows[0].ref, 'EB2');
  assert.equal(r.rows[1].links[0].kind, 'amazon');
});

test('a marketplace listing report is still treated as a photo catalog', async () => {
  const tsv = 'item-name\tseller-sku\timage-url\nDawn Orange 502ml\tS1\thttps://m.media-amazon.com/images/I/a.jpg\n';
  assert.equal((await parseSpreadsheet(Buffer.from(tsv), 'All Listings Report.txt')).kind, 'catalog');
});

test('imported links are matched to products and their photos fetched in the background', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'packing-')));
  store.importParsed(
    {
      type: 'sheet',
      orders: [
        { ref: 'EB1', recipient: 'A', lines: [{ name: 'Dawn Orange 502ml', qty: 1 }] },
        { ref: 'EB2', recipient: 'B', lines: [{ name: 'Lays Ketchup 220g', qty: 1 }, { name: 'KD Shaker 500g', qty: 1 }] },
      ],
    },
    's.pdf'
  );
  store.fetcher = async (url) => {
    if (url.includes('blocked')) throw new Error('the site answered 503');
    return url.replace('/listing/', '/photo/') + '.jpg';
  };
  const res = store.importLinks(
    [
      { ref: null, name: 'Dawn Orange 502ml', links: [{ url: 'https://www.amazon.ca/listing/dawn', kind: 'amazon' }] },
      { ref: 'EB2', name: '', links: [{ url: 'https://www.ebay.ca/listing/lays', kind: 'ebay' }] },
      { ref: 'EB2', name: '', links: [{ url: 'https://www.ebay.ca/blocked', kind: 'ebay' }] },
      { ref: null, name: 'Not on the sheet', links: [{ url: 'https://m.media-amazon.com/images/I/x.jpg', kind: 'image' }] },
    ],
    'links.csv'
  );
  assert.equal(res.today, 3);
  // Direct image links are used straight away.
  assert.equal(store.state.images[itemKey('Not on the sheet')], 'https://m.media-amazon.com/images/I/x.jpg');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.state.images[itemKey('Dawn Orange 502ml')], 'https://www.amazon.ca/photo/dawn.jpg');
  assert.equal(store.state.imageMeta[itemKey('Dawn Orange 502ml')].source, 'Amazon');
  // Second row for EB2 goes to its second item.
  assert.equal(store.state.images[itemKey('Lays Ketchup 220g')], 'https://www.ebay.ca/photo/lays.jpg');
  assert.match(store.state.photoJobs.failed[itemKey('KD Shaker 500g')].errors[0], /503/);
  assert.equal(store.state.photoJobs.pending, 0);
});
