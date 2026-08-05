import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser } from "playwright";
import {
  detectAntiBot,
  globalRateLimiter,
  retryWithBackoff,
  type AntiBotCheckResult,
} from "./resilience.js";

// Register stealth plugin once
chromium.use(stealthPlugin());

export interface FastExtractOptions {
  url: string;
  cssSelector?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  proxy?: string;
  maxRetries?: number;
}

export interface DeepExtractOptions {
  url: string;
  cssSelector?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  proxy?: string;
  maxRetries?: number;
}

/**
 * Serialize cookie key-value map into Cookie header string
 */
function serializeCookies(cookies?: Record<string, string>): string | undefined {
  if (!cookies || Object.keys(cookies).length === 0) return undefined;
  return Object.entries(cookies)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("; ");
}

/**
 * Fetch raw HTML content from a URL using native HTTP fetch with resilience, proxying, & headers/cookies.
 */
export async function fetchHtml(
  url: string,
  options: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
    proxy?: string;
  } = {}
): Promise<string> {
  const { timeoutMs = 10000, headers = {}, cookies, proxy } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const requestHeaders: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    ...headers,
  };

  const cookieHeader = serializeCookies(cookies);
  if (cookieHeader) {
    requestHeaders["Cookie"] = cookieHeader;
  }

  try {
    // Apply per-domain rate limiting
    await globalRateLimiter.throttle(url);

    const fetchOpts: any = {
      signal: controller.signal,
      headers: requestHeaders,
    };

    if (proxy) {
      fetchOpts.proxy = proxy;
    }

    const response = await fetch(url, fetchOpts);
    const htmlText = await response.text();

    const antiBotCheck: AntiBotCheckResult = detectAntiBot(response.status, htmlText);
    if (antiBotCheck.isBlocked) {
      throw new Error(`Anti-Bot protection triggered: ${antiBotCheck.reason}`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return htmlText;
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Configure Turndown instance for token-optimized HTML to Markdown conversion.
 */
function createTurndownService(): TurndownService {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
  });

  // Ignore images to save tokens
  turndownService.addRule("ignore-images", {
    filter: ["img"],
    replacement: () => "",
  });

  return turndownService;
}

/**
 * Shared Token-Optimization Pipeline:
 * JSDOM parsing -> Aggressive DOM Pruning -> CSS Selector scoping -> Readability -> Turndown Markdown
 */
export function processHtmlToMarkdown(
  rawHtml: string,
  options: { url: string; cssSelector?: string }
): string {
  const { url, cssSelector } = options;

  // 1. Virtual DOM Simulation
  const dom = new JSDOM(rawHtml, { url });
  const document = dom.window.document;

  // 2. Aggressive DOM Pruning (Token Economy)
  // Remove script, style, svg, iframe, noscript, nav, footer, and form tags
  const tagsToRemove = [
    "script",
    "style",
    "svg",
    "iframe",
    "noscript",
    "nav",
    "footer",
    "form",
  ];

  for (const tag of tagsToRemove) {
    const elements = Array.from(document.querySelectorAll(tag));
    for (const el of elements) {
      el.remove();
    }
  }

  // 3. Targeted Extraction (CSS Selector)
  if (cssSelector) {
    const targetNode = document.querySelector(cssSelector);
    if (targetNode) {
      document.body.innerHTML = targetNode.outerHTML;
    }
  }

  // 4. Readability & Turndown
  let cleanHtml = "";
  const reader = new Readability(document);
  const article = reader.parse();

  if (article && article.content) {
    cleanHtml = article.content;
  } else {
    // Fallback to pruned document body HTML if Readability yields empty content
    cleanHtml = document.body.innerHTML;
  }

  const turndownService = createTurndownService();
  let markdown = turndownService.turndown(cleanHtml);

  // Clean up consecutive blank lines & trailing whitespace
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

  return markdown;
}

/**
 * Execute Fast Extraction pipeline with retries:
 * Native Fetch -> Shared Token-Optimization Pipeline
 */
export async function extractFast(options: FastExtractOptions): Promise<string> {
  const { url, cssSelector, timeoutMs, headers, cookies, proxy, maxRetries = 3 } = options;

  return retryWithBackoff(
    async () => {
      const rawHtml = await fetchHtml(url, { timeoutMs, headers, cookies, proxy });
      return processHtmlToMarkdown(rawHtml, { url, cssSelector });
    },
    { maxRetries }
  );
}

/**
 * Allowed network resource types for lightweight SPA rendering.
 * ALLOW: document, script, fetch, xhr
 * ABORT: image, stylesheet, font, media, other
 */
const ALLOWED_RESOURCE_TYPES = new Set(["document", "script", "fetch", "xhr"]);

/**
 * Execute Deep Extraction pipeline (Playwright Chromium Engine with Stealth & Proxy):
 * Headless Browser -> Request Interception (Resource Blocking) -> DOM Rendering -> Anti-Bot check -> Token Pipeline
 */
export async function extractDeep(options: DeepExtractOptions): Promise<string> {
  const {
    url,
    cssSelector,
    timeoutMs = 15000,
    headers,
    cookies,
    proxy,
    maxRetries = 3,
  } = options;

  return retryWithBackoff(
    async () => {
      let browser: Browser | null = null;

      try {
        await globalRateLimiter.throttle(url);

        const launchOptions: any = {
          headless: true,
          args: [
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
          ],
        };

        if (proxy) {
          launchOptions.proxy = { server: proxy };
        }

        browser = (await chromium.launch(launchOptions)) as unknown as Browser;

        const context = await browser.newContext({
          userAgent:
            headers?.["User-Agent"] ||
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          viewport: { width: 1920, height: 1080 },
          locale: "en-US",
          timezoneId: "Europe/London",
        });

        if (headers) {
          await context.setExtraHTTPHeaders(headers);
        }

        if (cookies && Object.keys(cookies).length > 0) {
          const parsedUrl = new URL(url);
          const playwrightCookies = Object.entries(cookies).map(([name, value]) => ({
            name,
            value,
            domain: parsedUrl.hostname,
            path: "/",
          }));
          await context.addCookies(playwrightCookies);
        }

        const page = await context.newPage();

        // Crucial Optimization: Request Interception to save RAM & bandwidth
        await page.route("**/*", (route) => {
          const resourceType = route.request().resourceType();
          if (ALLOWED_RESOURCE_TYPES.has(resourceType)) {
            route.continue();
          } else {
            route.abort();
          }
        });

        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });

        await page.waitForTimeout(1000);

        const renderedHtml = await page.content();
        const status = response ? response.status() : 200;

        const antiBotCheck = detectAntiBot(status, renderedHtml);
        if (antiBotCheck.isBlocked) {
          throw new Error(`Anti-Bot protection triggered in deep crawl: ${antiBotCheck.reason}`);
        }

        return processHtmlToMarkdown(renderedHtml, { url, cssSelector });
      } finally {
        if (browser) {
          await browser.close().catch(() => {});
        }
      }
    },
    { maxRetries }
  );
}

export interface PageMetadata {
  title?: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogType?: string;
  ogUrl?: string;
  canonicalUrl?: string;
  author?: string;
  publishedTime?: string;
  keywords?: string[];
}

export interface StructuredExtractOptions {
  url: string;
  mode?: "fast" | "deep";
  schema?: Record<string, string>;
  includeMetadata?: boolean;
  cssSelector?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  proxy?: string;
  maxRetries?: number;
}

export interface StructuredExtractResult {
  url: string;
  metadata?: PageMetadata;
  data?: Record<string, string | string[]>;
  markdown: string;
}

export interface BatchExtractOptions {
  urls: string[];
  mode?: "fast" | "deep";
  concurrency?: number;
  cssSelector?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  proxy?: string;
  maxRetries?: number;
}

export interface BatchItemResult {
  url: string;
  success: boolean;
  markdown?: string;
  error?: string;
  charCount?: number;
  estimatedTokens?: number;
}

export interface BatchExtractResult {
  totalUrls: number;
  successful: number;
  failed: number;
  totalCharCount: number;
  totalEstimatedTokens: number;
  results: BatchItemResult[];
}

/**
 * Extract rich metadata (Open Graph tags, canonical URL, author, date, description, title) from raw HTML.
 */
export function extractMetadata(rawHtml: string, url: string): PageMetadata {
  const dom = new JSDOM(rawHtml, { url });
  const document = dom.window.document;

  const getMeta = (selector: string): string | undefined => {
    const el = document.querySelector(selector);
    const content = el?.getAttribute("content") || el?.getAttribute("href");
    return content ? content.trim() : undefined;
  };

  const title =
    document.title ||
    getMeta("meta[property='og:title']") ||
    getMeta("meta[name='twitter:title']");

  const description =
    getMeta("meta[name='description']") ||
    getMeta("meta[property='og:description']");

  const ogTitle = getMeta("meta[property='og:title']");
  const ogDescription = getMeta("meta[property='og:description']");
  const ogImage = getMeta("meta[property='og:image']");
  const ogType = getMeta("meta[property='og:type']");
  const ogUrl = getMeta("meta[property='og:url']");

  const canonicalUrl =
    document.querySelector("link[rel='canonical']")?.getAttribute("href") ||
    undefined;

  const author =
    getMeta("meta[name='author']") ||
    getMeta("meta[property='article:author']") ||
    getMeta("meta[name='twitter:creator']");

  const publishedTime =
    getMeta("meta[property='article:published_time']") ||
    getMeta("meta[name='publication-date']") ||
    getMeta("meta[name='date']");

  const keywordsRaw = getMeta("meta[name='keywords']");
  const keywords = keywordsRaw
    ? keywordsRaw
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
    : undefined;

  return {
    title: title?.trim(),
    description: description?.trim(),
    ogTitle,
    ogDescription,
    ogImage,
    ogType,
    ogUrl,
    canonicalUrl,
    author,
    publishedTime,
    keywords,
  };
}

/**
 * Helper to fetch raw HTML depending on mode ("fast" vs "deep")
 */
export async function fetchRawHtml(
  url: string,
  mode: "fast" | "deep" = "fast",
  options: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
    proxy?: string;
    maxRetries?: number;
  } = {}
): Promise<string> {
  if (mode === "deep") {
    const { timeoutMs = 15000, headers, cookies, proxy, maxRetries = 3 } = options;
    return retryWithBackoff(
      async () => {
        let browser: Browser | null = null;
        try {
          await globalRateLimiter.throttle(url);
          const launchOptions: any = {
            headless: true,
            args: [
              "--disable-blink-features=AutomationControlled",
              "--disable-features=IsolateOrigins,site-per-process",
            ],
          };
          if (proxy) launchOptions.proxy = { server: proxy };
          browser = (await chromium.launch(launchOptions)) as unknown as Browser;
          const context = await browser.newContext({
            userAgent:
              headers?.["User-Agent"] ||
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport: { width: 1920, height: 1080 },
            locale: "en-US",
            timezoneId: "Europe/London",
          });
          if (headers) await context.setExtraHTTPHeaders(headers);
          if (cookies && Object.keys(cookies).length > 0) {
            const parsedUrl = new URL(url);
            const playwrightCookies = Object.entries(cookies).map(([name, value]) => ({
              name,
              value,
              domain: parsedUrl.hostname,
              path: "/",
            }));
            await context.addCookies(playwrightCookies);
          }
          const page = await context.newPage();
          await page.route("**/*", (route) => {
            const resourceType = route.request().resourceType();
            if (ALLOWED_RESOURCE_TYPES.has(resourceType)) {
              route.continue();
            } else {
              route.abort();
            }
          });
          const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: timeoutMs,
          });
          await page.waitForTimeout(1000);
          const renderedHtml = await page.content();
          const status = response ? response.status() : 200;
          const antiBotCheck = detectAntiBot(status, renderedHtml);
          if (antiBotCheck.isBlocked) {
            throw new Error(`Anti-Bot protection triggered in deep crawl: ${antiBotCheck.reason}`);
          }
          return renderedHtml;
        } finally {
          if (browser) await browser.close().catch(() => {});
        }
      },
      { maxRetries }
    );
  } else {
    const { timeoutMs, headers, cookies, proxy, maxRetries = 3 } = options;
    return retryWithBackoff(
      async () => {
        return fetchHtml(url, { timeoutMs, headers, cookies, proxy });
      },
      { maxRetries }
    );
  }
}

/**
 * Perform structured extraction mapping custom CSS selectors to key-value schema
 */
export async function extractStructured(
  options: StructuredExtractOptions
): Promise<StructuredExtractResult> {
  const {
    url,
    mode = "fast",
    schema,
    includeMetadata = true,
    cssSelector,
    timeoutMs,
    headers,
    cookies,
    proxy,
    maxRetries = 3,
  } = options;

  const rawHtml = await fetchRawHtml(url, mode, {
    timeoutMs,
    headers,
    cookies,
    proxy,
    maxRetries,
  });

  const metadata = includeMetadata ? extractMetadata(rawHtml, url) : undefined;
  const markdown = processHtmlToMarkdown(rawHtml, { url, cssSelector });

  let data: Record<string, string | string[]> | undefined = undefined;

  if (schema && Object.keys(schema).length > 0) {
    const dom = new JSDOM(rawHtml, { url });
    const document = dom.window.document;
    data = {};

    for (const [key, selector] of Object.entries(schema)) {
      const elements = Array.from(document.querySelectorAll(selector));
      if (elements.length === 0) {
        data[key] = "";
      } else if (elements.length === 1) {
        data[key] = elements[0].textContent?.trim() || "";
      } else {
        data[key] = elements.map((el) => el.textContent?.trim() || "").filter(Boolean);
      }
    }
  }

  return {
    url,
    metadata,
    data,
    markdown,
  };
}

/**
 * Execute concurrent multi-URL batch extraction with token reporting.
 */
export async function batchExtract(
  options: BatchExtractOptions
): Promise<BatchExtractResult> {
  const {
    urls,
    mode = "fast",
    concurrency = 3,
    cssSelector,
    timeoutMs,
    headers,
    cookies,
    proxy,
    maxRetries = 3,
  } = options;

  const results: BatchItemResult[] = [];
  const queue = [...urls];

  const worker = async () => {
    while (queue.length > 0) {
      const targetUrl = queue.shift();
      if (!targetUrl) break;

      try {
        let markdown: string;
        if (mode === "deep") {
          markdown = await extractDeep({
            url: targetUrl,
            cssSelector,
            timeoutMs,
            headers,
            cookies,
            proxy,
            maxRetries,
          });
        } else {
          markdown = await extractFast({
            url: targetUrl,
            cssSelector,
            timeoutMs,
            headers,
            cookies,
            proxy,
            maxRetries,
          });
        }

        const charCount = markdown.length;
        const estimatedTokens = Math.ceil(charCount / 4);

        results.push({
          url: targetUrl,
          success: true,
          markdown,
          charCount,
          estimatedTokens,
        });
      } catch (err: any) {
        results.push({
          url: targetUrl,
          success: false,
          error: err.message || String(err),
        });
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);

  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const totalCharCount = results.reduce((acc, r) => acc + (r.charCount || 0), 0);
  const totalEstimatedTokens = results.reduce((acc, r) => acc + (r.estimatedTokens || 0), 0);

  return {
    totalUrls: urls.length,
    successful,
    failed,
    totalCharCount,
    totalEstimatedTokens,
    results,
  };
}

