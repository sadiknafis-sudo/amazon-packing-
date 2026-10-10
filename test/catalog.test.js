import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, matchScore, bestMatches, imageFromListingHtml } from '../lib/catalog.js';

test('reads an Amazon All Listings Report (tab separated)', async () => {
  const tsv = 'item-name\tseller-sku\timage-url\tasin1\nDawn Orange 502ml\tS1\thttps://m.media-amazon.com/images/I/a.jpg\tB01\nNo photo\tS2\t\tB02\n';
  const r = await parseReport(Buffer.from(tsv), 'All Listings Report.txt');
  assert.equal(r.source, 'Amazon');
  assert.equal(r.items.length, 1);
  assert.deepEqual(
    { title: r.items[0].title, image: r.items[0].image, sku: r.items[0].sku, asin: r.items[0].asin },
    { title: 'Dawn Orange 502ml', image: 'https://m.media-amazon.com/images/I/a.jpg', sku: 'S1', asin: 'B01' }
  );
});

test('reads a CSV with quoted titles and several picture links per cell', async () => {
  const csv = 'Item number,Title,Picture URL\n1,"Doritos Garlic & Parmesan, 210g","https://i.ebayimg.com/1.jpg|https://i.ebayimg.com/2.jpg"\n';
  const r = await parseReport(Buffer.from(csv), 'ebay.csv');
  assert.equal(r.items[0].title, 'Doritos Garlic & Parmesan, 210g');
  assert.equal(r.items[0].image, 'https://i.ebayimg.com/1.jpg');
});

test('explains when a report has no image column', async () => {
  await assert.rejects(parseReport(Buffer.from('Title,Price\nA,1\n'), 'x.csv'), /no column with image links/);
});

test('matching: same product scores high, other size or flavour scores low', () => {
  assert.ok(matchScore('Dawn Orange 502ml', 'Dawn Ultra Dish Soap, Orange Scent, 502 mL') >= 0.9);
  assert.ok(matchScore('Robin Hood All Purpose Flour Original 2.5kg', 'Robin Hood Original All Purpose Flour, 2.5 kg') >= 0.9);
  assert.ok(matchScore('Doritos Garlic and Parmesan 67g', 'Doritos Garlic & Parmesan Tortilla Chips, 210g') < 0.6);
  assert.ok(matchScore('Adams Peanut Butter Crunchy 1kg', 'Adams Natural Peanut Butter, Creamy, 1 kg') < 0.6);
  const best = bestMatches('Adams Peanut Butter Crunchy 1kg', [
    { title: 'Adams Natural Peanut Butter, Creamy, 1 kg', image: 'a' },
    { title: 'Adams Natural Peanut Butter, Crunchy, 1 kg', image: 'b' },
  ]);
  assert.equal(best[0].image, 'b');
});

test('finds the main photo in a listing page', () => {
  assert.equal(imageFromListingHtml('<img id="landingImage" data-old-hires="https://m.media-amazon.com/x.jpg" src="s.jpg">'), 'https://m.media-amazon.com/x.jpg');
  assert.equal(imageFromListingHtml('<meta property="og:image" content="https://i.ebayimg.com/y.jpg">'), 'https://i.ebayimg.com/y.jpg');
});
