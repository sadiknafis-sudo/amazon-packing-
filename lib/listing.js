// Turning an Amazon / Walmart / eBay listing link into its main product photo.

const IMAGE_HOSTS = /(^|\.)(media-amazon\.com|ssl-images-amazon\.com|images-amazon\.com|ebayimg\.com|walmartimages\.com|walmartimages\.ca)$/i;

// 'amazon' | 'walmart' | 'ebay' | 'image' | 'other'
export function classifyUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (IMAGE_HOSTS.test(host) || /\.(jpe?g|png|webp|gif)$/i.test(u.pathname)) return 'image';
  if (/(^|\.)(amazon\.[a-z.]+|amzn\.to|amzn\.com|a\.co)$/.test(host)) return 'amazon';
  if (/(^|\.)walmart\.[a-z.]+$/.test(host)) return 'walmart';
  if (/(^|\.)(ebay\.[a-z.]+|ebay\.us)$/.test(host)) return 'ebay';
  return 'other';
}

export const SOURCE_NAME = { amazon: 'Amazon', walmart: 'Walmart', ebay: 'eBay', image: 'Image link', other: 'Listing' };

// Bigger versions of marketplace thumbnails.
export function upgradeImage(url) {
  return url
    .replace(/(i\.ebayimg\.com\/.*\/s-l)\d+(\.\w+)/i, '$11600$2')
    .replace(/(media-amazon\.com\/images\/I\/[^.]+)\.[^/]*?(\.(jpe?g|png))$/i, '$1$2');
}

export async function fetchListingImage(link, { timeout = 15000 } = {}) {
  const r = await fetch(link, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en-CA,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  const type = r.headers.get('content-type') || '';
  if (type.startsWith('image/')) return r.url;
  if (!r.ok) throw new Error(`the site answered ${r.status}${r.status === 503 || r.status === 403 ? ' (it blocked the request)' : ''}`);
  const image = imageFromListingHtml(await r.text());
  if (!image) throw new Error('no product photo found on the page (the site may have shown a robot check)');
  return upgradeImage(new URL(image, r.url).href);
}

// Pulls the main product photo out of a listing page's HTML.
export function imageFromListingHtml(html) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? m[1].replace(/&amp;/g, '&').replace(/\\u002F/g, '/') : null;
  };
  return (
    pick(/data-old-hires="(https?:[^"]+)"/) || // Amazon main image
    pick(/"hiRes":"(https?:[^"]+)"/) ||
    pick(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
    pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/id="landingImage"[^>]+src="(https?:[^"]+)"/)
  );
}
