import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { itemKey } from '../lib/parse.js';

function freshStore() {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'packing-')));
  store.importParsed(
    {
      type: 'sheet',
      date: '10/09/2026',
      orders: [
        { ref: 'A1', recipient: 'ONE', lines: [{ name: 'Dawn Orange 502ml', qty: 4 }] },
        { ref: 'A2', recipient: 'TWO', lines: [{ name: 'Lays Ketchup 220g', qty: 1 }, { name: 'KD Shaker 500g', qty: 2 }] },
        { ref: 'A3', recipient: 'THREE', lines: [{ name: 'Dawn Orange 502ml', qty: 2 }] },
      ],
    },
    'sheet.pdf'
  );
  return store;
}
const order = (s, ref) => s.state.day.orders.find((o) => o.ref === ref);

test('two packers never get the same order', () => {
  const s = freshStore();
  s.act({ type: 'claim', packer: 0 });
  s.act({ type: 'claim', packer: 1 });
  assert.equal(order(s, 'A1').claimedBy, 0);
  assert.equal(order(s, 'A2').claimedBy, 1);
  s.act({ type: 'claim', packer: 0 }); // already has one, keeps it
  assert.equal(order(s, 'A3').claimedBy, null);
});

test('finishing an order claims the next free one', () => {
  const s = freshStore();
  s.act({ type: 'claim', packer: 0 });
  s.act({ type: 'claim', packer: 1 });
  s.act({ type: 'mark', id: 'A1-0', status: 'packed', packer: 0 });
  assert.equal(order(s, 'A3').claimedBy, 0);
});

test('undo reopens the last item and releases the newly claimed order', () => {
  const s = freshStore();
  s.act({ type: 'claim', packer: 0 });
  s.act({ type: 'mark', id: 'A1-0', status: 'missing', packer: 0 });
  assert.equal(order(s, 'A2').claimedBy, 0);
  s.act({ type: 'undo', packer: 0 });
  assert.equal(order(s, 'A1').lines[0].status, null);
  assert.equal(order(s, 'A1').claimedBy, 0);
  assert.equal(order(s, 'A2').claimedBy, null);
});

test('items bought by shoppers go back into the packing queue', () => {
  const s = freshStore();
  s.act({ type: 'mark', id: 'A1-0', status: 'missing', packer: 0 });
  s.act({ type: 'stock', key: itemKey('Dawn Orange 502ml'), status: 'bought', packer: 1 });
  s.act({ type: 'reopenBought', packer: 0 });
  assert.equal(order(s, 'A1').lines[0].status, null);
});

test('re-importing the same sheet does not duplicate orders', () => {
  const s = freshStore();
  const res = s.importParsed({ type: 'sheet', orders: [{ ref: 'A1', recipient: 'ONE', lines: [] }] }, 'again.pdf');
  assert.equal(res.skipped, 1);
  assert.equal(s.state.day.orders.length, 3);
});

test('new day clears lists but keeps photos', () => {
  const s = freshStore();
  s.act({ type: 'imageUrl', key: 'dawn orange 502ml', url: 'https://example.com/a.jpg' });
  s.act({ type: 'newDay' });
  assert.equal(s.state.day.orders.length, 0);
  assert.equal(s.state.images['dawn orange 502ml'], 'https://example.com/a.jpg');
});

test('half and half: each packer takes their own share, then can help', () => {
  const s = freshStore();
  s.act({ type: 'split', mode: 'half' });
  const owners = s.state.day.orders.map((o) => o.assigned);
  assert.ok(owners.includes(0) && owners.includes(1));
  s.act({ type: 'claim', packer: 1 });
  assert.equal(s.state.day.orders.find((o) => o.claimedBy === 1).assigned, 1);
});

test('by order type: Ref letters decide the packer, others go to either', () => {
  const s = freshStore();
  s.importParsed({ type: 'sheet', orders: [{ ref: 'EB9', recipient: 'X', lines: [{ name: 'Fritos Corn Chips 340g', qty: 1 }] }] }, 'b.pdf');
  s.act({ type: 'split', mode: 'prefix', prefix: 'EB', to: 1 });
  assert.equal(order(s, 'EB9').assigned, 1);
  assert.equal(order(s, 'A1').assigned, null);
  // Packer 0 never gets EB orders on their own...
  for (let i = 0; i < 4; i++) {
    const o = s.claimNext(0);
    if (o) for (const l of o.lines) s.act({ type: 'mark', id: l.id, status: 'packed', packer: 0 });
  }
  assert.equal(order(s, 'EB9').claimedBy, null);
  // ...unless they choose to help.
  s.act({ type: 'claim', packer: 0, help: true });
  assert.equal(order(s, 'EB9').claimedBy, 0);
});

test('listing reports set photos for exact name matches only', () => {
  const s = freshStore();
  const res = s.addToCatalog(
    {
      source: 'Amazon',
      rows: 2,
      columns: {},
      items: [
        { title: 'Dawn Orange 502ml', key: itemKey('Dawn Orange 502ml'), image: 'https://x/dawn.jpg', source: 'Amazon' },
        { title: 'Kraft Dinner KD Shaker 500 g', key: itemKey('Kraft Dinner KD Shaker 500 g'), image: 'https://x/kd.jpg', source: 'Amazon' },
      ],
    },
    'r.txt'
  );
  assert.equal(res.photos, 1);
  assert.equal(s.state.images[itemKey('Dawn Orange 502ml')], 'https://x/dawn.jpg');
  assert.equal(s.state.images[itemKey('KD Shaker 500g')], undefined);
  assert.equal(s.suggestions()[0].candidates[0].image, 'https://x/kd.jpg');
});
