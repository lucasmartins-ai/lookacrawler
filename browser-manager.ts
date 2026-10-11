import type { Browser } from "playwright";
import { chromium } from "playwright";
import { buildStealthInit } from "./stealth.js";
import { getEgressGuard } from "./egress-guard.js";
import { isLocalAccessAllowed, validateProxyUrl } from "./security.js";
import { registerCleanup } from "./lifecycle.js";

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
 * Each distinct proxy needs its own Chromium process, and the proxy can come
 * from a tool argument. Without a ceiling a caller can open browsers until the
 * machine runs out of memory, so we cap how many exist at once and close the
 * ones that sit idle.
 */
const MAX_BROWSERS = Math.max(1, Number(process.env.LOOKACRAWLER_MAX_BROWSERS || 4));
const IDLE_BROWSER_MS = Math.max(5_000, Number(process.env.LOOKACRAWLER_BROWSER_IDLE_MS || 120_000));
const lastUsed = new Map<string, number>();
let sweeper: ReturnType<typeof setInterval> | null = null;

async function isIdle(entry: Promise<Browser>): Promise<boolean> {
  try {
    const b = await entry;
    return b.contexts().length === 0;
  } catch {
    return true;
  }
}

async function closeEntry(key: string): Promise<void> {
  const entry = browsers.get(key);
  browsers.delete(key);
  lastUsed.delete(key);
  if (entry) await entry.then((b) => b.close()).catch(() => {});
}

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(async () => {
    const now = Date.now();
    for (const [key, entry] of [...browsers.entries()]) {
      if (now - (lastUsed.get(key) || 0) > IDLE_BROWSER_MS && (await isIdle(entry))) {
        await closeEntry(key);
      }
    }
    if (browsers.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, Math.min(IDLE_BROWSER_MS, 30_000));
  (sweeper as any).unref?.();
}

/** Make room for one more browser, evicting the least recently used idle one. */
async function reserveSlot(): Promise<void> {
  if (browsers.size < MAX_BROWSERS) return;
  const byAge = [...browsers.keys()].sort((a, b) => (lastUsed.get(a) || 0) - (lastUsed.get(b) || 0));
  for (const key of byAge) {
    const entry = browsers.get(key);
    if (entry && (await isIdle(entry))) {
      await closeEntry(key);
      return;
    }
  }
  throw new Error(
    `Too many concurrent browser proxies (limit ${MAX_BROWSERS}); retry later or raise LOOKACRAWLER_MAX_BROWSERS`
  );
}

interface LaunchProxy {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}

/**
 * Get (or lazily create) a shared browser instance for a proxy key.
 *
 * Without an explicit proxy, the browser is routed through the local egress
 * guard (see `egress-guard.ts`), which validates the destination of every
 * connection — redirects, fetch/xhr and WebSockets included.
 *
 * We prefer the REAL Google Chrome channel (`channel: "chrome"`) because its
 * TLS fingerprint, UA, and JS surface closely match a human browser and it is
 * far less likely to be challenged than the bundled Playwright Chromium. If the
 * real Chrome is not installed, we fall back to the bundled Chromium so the tool
 * still works out of the box.
 */
export async function getBrowser(proxy?: string): Promise<Browser> {
  let key: string;
  let launchProxy: LaunchProxy | undefined;
  if (proxy && proxy.trim()) {
    const validated = await validateProxyUrl(proxy);
    key = `proxy:${validated}`;
    launchProxy = { server: validated };
  } else if (isLocalAccessAllowed()) {
    key = "direct";
  } else {
    key = "guard";
    const guard = await getEgressGuard();
    // "<-loopback>" removes Chromium's implicit proxy bypass for localhost, so
    // even a redirect to 127.0.0.1 has to go through the guard.
    launchProxy = { server: guard.server, bypass: "<-loopback>", username: guard.username, password: guard.password };
  }

  lastUsed.set(key, Date.now());
  let browser = browsers.get(key);
  if (!browser) {
    await reserveSlot();
    // Another caller may have created it while we were evicting.
    const raced = browsers.get(key);
    if (raced) return raced;
    const baseArgs: string[] = [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ];
    browser = launchWithFallback(launchProxy, baseArgs)
      .then((b) => {
        b.on("disconnected", () => {
          if (browsers.get(key) === browser) {
            browsers.delete(key);
            lastUsed.delete(key);
          }
        });
        return b;
      })
      .catch((error) => {
        browsers.delete(key);
        lastUsed.delete(key);
        throw error;
      }) as Promise<Browser>;
    browsers.set(key, browser);
    ensureSweeper();
  }
  return browser;
}

/** Try real Chrome first; degrade to bundled Chromium if the channel is unavailable. */
async function launchWithFallback(proxy: LaunchProxy | undefined, baseArgs: string[]): Promise<Browser> {
  const launch = (extra: Record<string, unknown>) => {
    const opts: any = {
      headless: true,
      args: [...new Set([...baseArgs, ...STEALTH_ARGS])],
      ...(proxy ? { proxy } : {}),
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
  lastUsed.clear();
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  const resolved = await Promise.allSettled(openBrowsers);
  await Promise.all(resolved.map((result) =>
    result.status === "fulfilled" ? result.value.close().catch(() => {}) : Promise.resolve()
  ));
}

registerCleanup(closeBrowsers);
