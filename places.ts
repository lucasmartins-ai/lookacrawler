import { getBrowser, getStealthInit } from "./browser-manager.js";
import { retryWithBackoff } from "./resilience.js";

export interface PlaceEntity {
  title: string;
  category?: string;
  address?: string;
  phone?: string;
  website?: string;
  rating?: number;
  reviewCount?: number;
  latitude?: number;
  longitude?: number;
  url?: string;
}

export interface SearchPlacesOptions {
  query: string;
  limit?: number;
  timeoutMs?: number;
  proxy?: string;
}

export interface SearchPlacesResult {
  query: string;
  totalFound: number;
  places: PlaceEntity[];
}

/**
 * Search for local businesses and places on Google Maps, extracting structured entity data.
 */
export async function searchPlaces(options: SearchPlacesOptions): Promise<SearchPlacesResult> {
  const { query, limit = 5, timeoutMs = 25000, proxy } = options;

  if (!query || query.trim().length === 0) {
    throw new Error("Search query cannot be empty");
  }

  const encodedQuery = encodeURIComponent(query.trim());
  const searchUrl = `https://www.google.com/maps/search/${encodedQuery}`;

  let context: any = null;
  const places: PlaceEntity[] = [];

  try {
    const browser = await getBrowser(proxy);
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "pt-BR",
    });

    await context.addInitScript(getStealthInit());
    const page = await context.newPage();

    await retryWithBackoff(
      async () => {
        await page.goto(searchUrl, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
      },
      2,
      1000
    );

    // Wait briefly for map cards or direct business pane to render
    await page.waitForTimeout(2000);

    // Handle the Google consent interstitial. It redirects to consent.google.com
    // and blocks Maps entirely until answered, so this must run before any
    // structural check — the page genuinely has no places without it.
    // The button is localized, so match several languages rather than one.
    try {
      const consentBtn = page
        .locator(
          'button[aria-label="Accept all"], button[aria-label="Aceitar todos"], ' +
            'button[aria-label="Tout accepter"], button[aria-label="Alle akzeptieren"], ' +
            'button[aria-label="Aceptar todo"], button[aria-label="Accetta tutto"], ' +
            'form[action*="consent"] button'
        )
        .first();
      if (await consentBtn.isVisible({ timeout: 4000 })) {
        await consentBtn.click({ timeout: 8000 });
        // Consent redirects back to Maps; wait for the real page to land.
        await page.waitForURL((u: URL) => !u.hostname.includes("consent.google.com"), {
          timeout: 20000,
        }).catch(() => {});
        await page.waitForTimeout(4000);
      }
    } catch {
      /* ignore consent dismiss failure */
    }

    // Decide between a single-place page and a results list by structure, not
    // by the h1. The results view is headed "Results" (localised), so the
    // previous check read that heading as a business name and returned one
    // bogus place while the ten real cards on the page went unparsed.
    const placeCards = page.locator('a[href*="/maps/place/"]');
    const cardCount = await placeCards.count();

    if (cardCount === 0) {
      const directTitle = await page
        .locator('h1.DUwDvf, [role="main"] h1')
        .first()
        .textContent()
        .catch(() => null);
      if (directTitle && directTitle.trim()) {
        places.push(await extractSinglePlaceDetails(page, directTitle.trim()));
      }
    } else {
      const seenUrls = new Set<string>();
      const maxToFetch = Math.min(limit, cardCount);

      for (let i = 0; i < maxToFetch && places.length < limit; i++) {
        try {
          const card = placeCards.nth(i);
          const href = await card.getAttribute("href");
          if (!href || seenUrls.has(href)) continue;
          seenUrls.add(href);

          const ariaLabel = await card.getAttribute("aria-label");
          const title = ariaLabel || (await card.textContent()) || `Result ${i + 1}`;

          const { latitude, longitude } = parseCoordinatesFromUrl(href);

          // The anchor only carries the name. Rating, review count, category and
          // address live in the sibling container one level up, so read them
          // from the card rather than opening each place page.
          const meta = await readCardMeta(page, i);

          places.push({
            title: title.trim(),
            url: href.startsWith("http") ? href : `https://www.google.com${href}`,
            latitude,
            longitude,
            rating: meta.rating,
            reviewCount: meta.reviewCount,
            category: meta.category,
            address: meta.address,
          });
        } catch {
          /* continue to next card */
        }
      }
    }
  } catch (err: any) {
    // If Playwright fails (e.g. offline/mocked), return empty result instead of crashing
    return {
      query,
      totalFound: places.length,
      places: places.slice(0, limit),
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }

  return {
    query,
    totalFound: places.length,
    places: places.slice(0, limit),
  };
}

/**
 * Read rating, review count, category and address out of a result card.
 *
 * The `<a href="/maps/place/...">` anchor holds only the business name. The rest
 * sits in the enclosing card (`div.Nv2PK`), whose textContent reads roughly
 * "Name / 4.8(58) / Dental clinic · 12 Cassey Bottom, Bristol". Parsing that
 * text is far cheaper than opening each place page, and keeps a 20-lead sweep
 * at one page load instead of twenty.
 *
 * Everything is optional: a card missing a field yields undefined, never a
 * throw, so one odd layout cannot abort the whole batch.
 */
async function readCardMeta(
  page: any,
  index: number
): Promise<{ rating?: number; reviewCount?: number; category?: string; address?: string }> {
  try {
    return await page.evaluate((i: number) => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
      const anchor = anchors[i] as HTMLElement | undefined;
      if (!anchor) return {};

      // Climb to the nearest container whose text is richer than the name.
      let el: HTMLElement | null = anchor;
      for (let up = 0; up < 5 && el; up++) {
        const text = (el.innerText || "").trim();
        if (text.length > 40 && text !== (anchor.getAttribute("aria-label") || "")) break;
        el = el.parentElement;
      }
      const text = ((el as HTMLElement)?.innerText || "").trim();
      if (!text) return {};

      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      let rating: number | undefined;
      let reviewCount: number | undefined;
      let category: string | undefined;
      let address: string | undefined;

      for (const line of lines) {
        // "4.8(128)" or "4.8 (1.2K)"
        const score = line.match(/^(\d+[.,]\d+)\s*\(([\d.,K]+)\)/);
        if (score && rating === undefined) {
          rating = parseFloat(score[1].replace(",", "."));
          const raw = score[2].replace(/\./g, "");
          reviewCount = /K$/i.test(raw) ? Math.round(parseFloat(raw) * 1000) : parseInt(raw, 10);
          continue;
        }
        // "Dental clinic · 12 Cassey Bottom, Bristol" — the separator is a
        // middot that sometimes survives with stray spaces around it.
        const dot = line.match(/^([^·\n]{2,60}?)\s*·\s*(.+)$/);
        if (dot && category === undefined) {
          category = dot[1].trim();
          address = dot[2].trim();
          continue;
        }
        // Some cards render the address on its own line, others prefix a
        // status word: "Open · 283 Speedwell Rd". Keep the trailing address.
        if (!address && /\d/.test(line) && line.length > 8 && line !== category) {
          address = line;
        }
      }

      // Drop a leading status/category word joined by a middot ("Open · 12 St")
      // and any stray separator characters around the value.
      if (address) {
        const middot = address.match(/^[^·\n]{2,24}·\s*(.+)$/);
        if (middot) address = middot[1];
        address = address.replace(/^[·\s]+|[·\s]+$/g, "").trim();
      }

      return {
        ...(rating !== undefined && !isNaN(rating) ? { rating } : {}),
        ...(reviewCount !== undefined && !isNaN(reviewCount) ? { reviewCount } : {}),
        ...(category ? { category } : {}),
        ...(address ? { address } : {}),
      };
    }, index);
  } catch {
    return {};
  }
}

/**
 * Parses latitude and longitude from Google Maps URLs (e.g. /@ -23.561684,-46.655981,15z/).
 */
export function parseCoordinatesFromUrl(url: string): { latitude?: number; longitude?: number } {
  if (!url) return {};
  // Modern place URLs encode coordinates as !3d<lat>!4d<lng> inside the data
  // parameter; older links use the @lat,lng,zoom path form. Supporting only the
  // latter silently dropped every coordinate from current Maps results.
  const hex = url.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
  if (hex) {
    return { latitude: parseFloat(hex[1]), longitude: parseFloat(hex[2]) };
  }
  const coordsMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (coordsMatch) {
    return {
      latitude: parseFloat(coordsMatch[1]),
      longitude: parseFloat(coordsMatch[2]),
    };
  }
  return {};
}

async function extractSinglePlaceDetails(page: any, title: string): Promise<PlaceEntity> {
  let address: string | undefined;
  let phone: string | undefined;
  let website: string | undefined;
  let rating: number | undefined;
  let reviewCount: number | undefined;

  try {
    // Address button usually has data-item-id="address" or aria-label starting with Endereço
    const addressEl = page.locator('button[data-item-id="address"], [data-tooltip="Copiar endereço"]');
    address = (await addressEl.first().textContent())?.trim();
  } catch {}

  try {
    // Phone button
    const phoneEl = page.locator('button[data-item-id*="phone"], [data-tooltip="Copiar número de telefone"]');
    phone = (await phoneEl.first().textContent())?.trim();
  } catch {}

  try {
    // Website anchor
    const siteEl = page.locator('a[data-item-id="authority"], [aria-label*="Website"], [aria-label*="Site"]');
    website = await siteEl.first().getAttribute("href");
  } catch {}

  try {
    // Rating span
    const ratingEl = page.locator('span.ceNzKf, span[aria-hidden="true"]:has-text(",")');
    const ratingText = await ratingEl.first().textContent();
    if (ratingText) {
      rating = parseFloat(ratingText.replace(",", "."));
    }
  } catch {}

  return {
    title,
    address,
    phone,
    website,
    rating,
    reviewCount,
    url: page.url(),
  };
}
