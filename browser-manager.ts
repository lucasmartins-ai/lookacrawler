import type { Browser } from "playwright";
import { chromium } from "playwright";
import { buildStealthInit } from "./stealth.js";

const browsers = new Map<string, Promise<Browser>>();

/**
 * Launch args that reduce the headless footprint. These are additive / safe for
 * a browser we drive ourselves. `--disable-blink-features=AutomationControlled`
 * alone is NOT sufficient against Cloudflare; the per-page `stealthInit` patches
 * (see `stealth.ts`) do the heavy lifting.
 */
const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process,AutomationControlled",
  "--no-default-browser-check",
  "--disable-popup-blocking",
  "--no-first-run",
  "--no-sandbox",
  "--disable-dev-shm-usage",
];

/**
 * Get (or lazily create) a shared browser instance for a proxy key.
 *
 * We prefer the REAL Google Chrome channel (`channel: "chrome"`) because its
 * TLS fingerprint, UA, and JS surface closely match a human browser and it is
 * far less likely to be challenged than the bundled Playwright Chromium. If the
 * real Chrome is not installed, we fall back to the bundled Chromium so the tool
 * still works out of the box.
 */
export function getBrowser(proxy?: string): Promise<Browser> {
  const key = proxy || "direct";
  let browser = browsers.get(key);
  if (!browser) {
    const baseArgs: string[] = [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ];
    browser = launchWithFallback(proxy, baseArgs)
      .then((b) => {
        b.on("disconnected", () => {
          if (browsers.get(key) === browser) {
            browsers.delete(key);
          }
        });
        return b;
      })
      .catch((error) => {
        browsers.delete(key);
        throw error;
      }) as Promise<Browser>;
    browsers.set(key, browser);
  }
  return browser;
}

/** Try real Chrome first; degrade to bundled Chromium if the channel is unavailable. */
async function launchWithFallback(proxy: string | undefined, baseArgs: string[]): Promise<Browser> {
  const launch = (extra: Record<string, unknown>) => {
    const opts: any = {
      headless: true,
      args: [...new Set([...baseArgs, ...STEALTH_ARGS])],
      ...(proxy ? { proxy: { server: proxy } } : {}),
      ...extra,
    };
    return chromium.launch(opts);
  };

  try {
    // Prefer the installed Google Chrome (real fingerprint, best escape rate).
    return await launch({ channel: "chrome", timeout: 4000 });
  } catch {
    // Fall back to Playwright's bundled Chromium — still functional, more detectable.
    return await launch({ timeout: 5000 });
  }
}

/** A fresh stealth init-script (one function, self-contained, serializable). */
export function getStealthInit(): () => void {
  return buildStealthInit();
}

export async function closeBrowsers(): Promise<void> {
  const openBrowsers = [...browsers.values()];
  browsers.clear();
  const resolved = await Promise.allSettled(openBrowsers);
  await Promise.all(resolved.map((result) =>
    result.status === "fulfilled" ? result.value.close().catch(() => {}) : Promise.resolve()
  ));
}
