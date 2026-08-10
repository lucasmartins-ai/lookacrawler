import type { Browser } from "playwright";
import { chromium } from "playwright";

const browsers = new Map<string, Promise<Browser>>();

export function getBrowser(proxy?: string): Promise<Browser> {
  const key = proxy || "direct";
  let browser = browsers.get(key);
  if (!browser) {
    browser = chromium.launch({
      headless: true,
      ...(proxy ? { proxy: { server: proxy } } : {}),
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    }).catch((error) => {
      browsers.delete(key);
      throw error;
    }) as Promise<Browser>;
    browsers.set(key, browser);
  }
  return browser;
}

export async function closeBrowsers(): Promise<void> {
  const openBrowsers = [...browsers.values()];
  browsers.clear();
  const resolved = await Promise.allSettled(openBrowsers);
  await Promise.all(resolved.map((result) =>
    result.status === "fulfilled" ? result.value.close().catch(() => {}) : Promise.resolve()
  ));
}
