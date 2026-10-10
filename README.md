# Packing app

A tablet/phone app for the warehouse packers:

- **Pack**: shows one item at a time with a **big product photo**, the order ref, recipient and quantity.
  Tap the photo (or **✓ Packed**) and it turns **green** and moves to the next item.
  Tap **✗ Don't have** and it turns **red** and moves on. **↶ Back** undoes the last tap.
- **Two packers**: each device picks Packer 1 or Packer 2. Orders are handed out one at a time from the
  same queue, so the two packers never get the same order, and both screens update live.
- **Stock check**: in the morning a packer goes through the **total items list** (grid, or "one by one" with
  big photos) and marks each product green (we have it) or red (missing). Red items can have a "buy"
  quantity.
- **Shopping list**: every red item, from the morning check or found missing while packing.
  The purchasers can copy it to WhatsApp/text, share it or print it for the shoppers. When the shoppers come back, tap
  **Bought**. The packers then see a "pack those orders now" button that puts those orders back in the queue.
- **Summary**: orders packed, orders waiting on missing items, orders left, per-packer counts, and a full
  order table (tap an order to re-open or reset it).
- **Setup**: import the PDFs, set the packer names, add product photos, start a new day.

## Running it

Needs [Node.js](https://nodejs.org) 18 or newer on one computer in the warehouse (it acts as the server).

```bash
npm install
npm start
```

It prints the addresses to open, for example:

```
On this computer:  http://localhost:3000
On tablets/phones: http://192.168.1.20:3000
```

Open the second address on each packer's tablet or phone (same Wi-Fi). In the browser menu choose
**Add to Home screen** so it opens full screen like an app.

Use `PORT=8080 npm start` to change the port. All data is saved in the `data/` folder (`DATA_DIR` to change).

## Daily routine

1. **Setup → Import**: choose today's `Packing Sheet` PDF(s) and the `Total Items Pick List` PDF
   (you can select them all at once; the app works out which is which). Importing the same sheet twice
   does not create duplicate orders.
2. **Stock check**: go through the total list and mark what we have and what's missing.
3. **Shopping list**: send the missing items to the shoppers, and tap **Bought** when they come back.
4. **Pack**: each packer picks their name and packs.
5. Next morning: **Setup → Start a new day** clears lists and progress. **Photos are kept.**

## Product photos

The PDFs have no pictures, so photos are added once and then remembered by product name for every
later day. Tap **📷 Add photo** on any product (on the pack screen, in the stock check, or in
Setup → Product photos, which lists every product still missing a photo). You can:

- take a photo of the item with the tablet camera,
- pick a picture saved on the device (there's a button to search Google Images for the product), or
- paste a link to an image.

## Keyboard shortcuts (pack screen)

`Enter`/`Space` = packed · `X` = don't have · `Z` = back.

## Development

```bash
npm test   # store logic tests
```

- `server.js`: HTTP server, live updates (Server-Sent Events), PDF import, photo upload
- `lib/parse.js`: reads the Packing Sheet / Total Items Pick List PDFs (handles wrapped names and
  multi-item orders)
- `lib/store.js`: shared state and actions (claiming orders, marking items, stock, undo)
- `public/`: the front end (plain HTML/CSS/JS, no build step)
