# Packing app

A tablet/phone app for the warehouse packers:

- **Pack**: shows one item at a time with a **big product photo**, the order ref, recipient and quantity.
  Tap the photo (or **✓ Packed**) and it turns **green** and moves to the next item.
  Tap **✗ Don't have** and it turns **red** and moves on. **↶ Back** undoes the last tap.
- **Two packers**: each device picks Packer 1 or Packer 2. Orders are divided as a shared list, half and half,
  or by order type (Ref letters). The two packers never get the same order, and both screens update live.
- **Stock check**: in the morning a packer goes through the **total items list** (grid, or "one by one" with
  big photos) and marks each product green (we have it) or red (missing). Red items can have a "buy"
  quantity.
- **Shopping list**: every red item, from the morning check or found missing while packing.
  The purchasers can copy it to WhatsApp/text, share it or print it for the shoppers. When the shoppers come back, tap
  **Bought**. The packers then see a "pack those orders now" button that puts those orders back in the queue.
- **Summary**: orders packed, orders waiting on missing items, orders left, per-packer counts, and a full
  order table (tap an order to re-open or reset it).
- **Setup**: import the PDFs, set the packer names, choose how orders are divided, import listing photos, start a new day.

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

## Product photos (real Amazon / Walmart / eBay listing photos)

The packing PDFs have no pictures, so the app gets them from your marketplace listings. Photos are
remembered by product name, so each product only needs a photo once.

**1. Import your listing reports (best: does most products at once).** Setup → *Listing photos*.
Download a listing report from each marketplace and drop it in. Excel (.xlsx), CSV and tab-separated .txt all work.

| Marketplace | Report | Columns used |
|---|---|---|
| Amazon | Seller Central → Inventory → Inventory Reports → *All Listings Report* (or *Category Listings Report*) | `item-name` + `image-url` / `main-image-url` |
| Walmart | Seller Center → Items → Download → item report | Product Name + Primary Image URL |
| eBay | Seller Hub → Reports → Downloads (active listings), or a File Exchange / bulk export | Title + Picture URL |
| Other | Any CSV/Excel file | a title column + an image link column |

The app finds the title and image columns by itself and keeps every listing, so packing sheets on
later days also get photos automatically.
- **Exact name match** → the photo is set automatically.
- **Close match** (for example "KD Shaker 500g" vs "Kraft Dinner KD Shaker Cheese Topping 500 g") → it shows up under
  *Check suggested photos*. Check that the flavour and size are right, then tap it. Different sizes
  (67g vs 210g) are never suggested as a good match.

**2. One product at a time.** Tap **📷** on any product, open the listing with the 🔎 Amazon / Walmart /
eBay buttons, copy the listing link and paste it in **Use the listing's photo**. If the site blocks it,
long-press or right-click the main photo, choose *Copy image address*, and paste that instead. You can also take a photo
with the tablet camera.

On the pack screen a small tag says where the photo came from (for example "Amazon listing photo").
Listing photos load from the marketplace's image servers, so the tablets need internet access.

## Dividing orders between the two packers

Setup → *How to divide orders*:

- **Shared list** (default): both packers work down the same list, and whoever is free takes the next order.
  Nobody waits and nobody gets the same order.
- **Half and half**: Packer 1 gets the first half of the sheet and Packer 2 the second half. The split is balanced by
  number of units, not just orders.
- **By order type**: pick a packer for each Ref prefix (`EB`, `WS`, `C`, `CN`, `M`, `WE`, `P` …).
  Prefixes left on *Either* go to whoever is free.

With half and half or by order type, a packer who finishes their share gets a **Help** button. It
gives them the other packer's remaining orders, starting from the end of the list so they don't
collide.

## Keyboard shortcuts (pack screen)

`Enter`/`Space` = packed · `X` = don't have · `Z` = back.

## Development

```bash
npm test   # store, matching and report tests
```

- `server.js`: HTTP server, live updates (Server-Sent Events), PDF import, photo upload
- `lib/parse.js`: reads the Packing Sheet / Total Items Pick List PDFs (handles wrapped names and
  multi-item orders)
- `lib/catalog.js`: reads marketplace listing reports (CSV/TSV/XLSX) and matches listing titles to products
- `lib/store.js`: shared state and actions (dividing and claiming orders, marking items, stock, photos, undo)
- `public/`: the front end (plain HTML/CSS/JS, no build step)
