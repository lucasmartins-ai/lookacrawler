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

    // Handle any cookie consent banner if present
    try {
      const consentBtn = page.locator('button[aria-label*="Aceitar"], button[aria-label*="Accept"], form[action*="consent"] button');
      if (await consentBtn.first().isVisible({ timeout: 1500 })) {
        await consentBtn.first().click();
        await page.waitForTimeout(1000);
      }
    } catch {
      /* ignore consent dismiss failure */
    }

    // Check if directly redirected to a single place page
    const directTitle = await page.locator('h1.DUwDvf, [role="main"] h1').first().textContent().catch(() => null);
    if (directTitle && directTitle.trim()) {
      const singlePlace = await extractSinglePlaceDetails(page, directTitle.trim());
      places.push(singlePlace);
    } else {
      // Multiple search results list view
      // Feed selector for places: div[role="feed"] > div > div[jsaction] or a[href*="/maps/place/"]
      const placeCards = page.locator('a[href*="/maps/place/"]');
      const count = await placeCards.count();

      const seenUrls = new Set<string>();
      const maxToFetch = Math.min(limit, count > 0 ? count : 0);

      for (let i = 0; i < maxToFetch && places.length < limit; i++) {
        try {
          const card = placeCards.nth(i);
          const href = await card.getAttribute("href");
          if (!href || seenUrls.has(href)) continue;
          seenUrls.add(href);

          const ariaLabel = await card.getAttribute("aria-label");
          const title = ariaLabel || (await card.textContent()) || `Result ${i + 1}`;

          const { latitude, longitude } = parseCoordinatesFromUrl(href);

          places.push({
            title: title.trim(),
            url: href.startsWith("http") ? href : `https://www.google.com${href}`,
            latitude,
            longitude,
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
 * Parses latitude and longitude from Google Maps URLs (e.g. /@ -23.561684,-46.655981,15z/).
 */
export function parseCoordinatesFromUrl(url: string): { latitude?: number; longitude?: number } {
  if (!url) return {};
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
