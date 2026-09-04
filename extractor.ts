import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { Browser } from "playwright";
import {
  detectAntiBot,
  globalRateLimiter,
  retryWithBackoff,
  type AntiBotCheckResult,
} from "./resilience.js";
import { getBrowser, getStealthInit } from "./browser-manager.js";
import { getMaxResponseBytes, validateTargetUrl } from "./security.js";
import { buildCacheKey, getCachedPage, setCachedPage } from "./cache.js";
import { recordMetric } from "./metrics.js";

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

const fastInFlight = new Map<string, Promise<string>>();
const deepInFlight = new Map<string, Promise<string>>();

function requestKey(options: FastExtractOptions | DeepExtractOptions): string {
  return JSON.stringify(options);
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
  await validateTargetUrl(url);
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

    let currentUrl = url;
    let response: Response | undefined;
    for (let redirect = 0; redirect <= 5; redirect++) {
      response = await fetch(currentUrl, { ...fetchOpts, redirect: "manual" });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location || redirect === 5) throw new Error(`HTTP ${response.status}: redirect limit exceeded`);
      currentUrl = new URL(location, currentUrl).toString();
      await validateTargetUrl(currentUrl);
      await globalRateLimiter.throttle(currentUrl);
    }
    if (!response) throw new Error("Request did not return a response");
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > getMaxResponseBytes()) {
      throw new Error(`Response exceeds maximum size of ${getMaxResponseBytes()} bytes`);
    }
    const htmlText = await response.text();
    if (Buffer.byteLength(htmlText, "utf8") > getMaxResponseBytes()) {
      throw new Error(`Response exceeds maximum size of ${getMaxResponseBytes()} bytes`);
    }
    recordMetric("bytesFetched", Buffer.byteLength(htmlText, "utf8"));

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
  const dom = new JSDOM(rawHtml, { url });
  return processDocumentToMarkdown(dom.window.document, cssSelector);
}

function processDocumentToMarkdown(document: Document, cssSelector?: string): string {

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
export function extractFast(options: FastExtractOptions): Promise<string> {
  const key = requestKey(options);
  const existing = fastInFlight.get(key);
  if (existing) return existing;
  const promise = extractFastOnce(options).finally(() => fastInFlight.delete(key));
  fastInFlight.set(key, promise);
  return promise;
}

async function extractFastOnce(options: FastExtractOptions): Promise<string> {
  const { url, cssSelector, timeoutMs, headers, cookies, proxy, maxRetries = 3 } = options;

  recordMetric("requests");
  const startedAt = Date.now();
  try {
    const result = await retryWithBackoff(
    async () => {
      const rawHtml = await fetchHtml(url, { timeoutMs, headers, cookies, proxy });
      return processHtmlToMarkdown(rawHtml, { url, cssSelector });
    },
    { maxRetries }
  );
    recordMetric("successes");
    recordMetric("durationMs", Date.now() - startedAt);
    return result;
  } catch (error) {
    // Escalate to stealth/real-browser (deep) when the quick fetch is blocked.
    // Bun's native fetch has a detectable TLS/HTTP2 fingerprint, so Cloudflare
    // (and similar) stop it. A real browser (or a robust proxy) is more likely
    // to pass — without this, the default `fast` path silently returns 0 bytes.
    const message = error instanceof Error ? error.message : String(error);
    const antiBot = /Anti-Bot protection/i.test(message) || /cloudflare/i.test(message) || /just a moment/i.test(message);
    if (antiBot) {
      recordMetric("escalations");
      console.error(`[lookacrawler] fast blocked by anti-bot (${message.slice(0, 90)}); escalating to deep/stealth...`);
      return extractDeep({
        url,
        cssSelector,
        timeoutMs,
        headers,
        cookies,
        proxy,
        maxRetries: Math.max(1, maxRetries - 1),
      });
    }
    recordMetric("failures");
    recordMetric("durationMs", Date.now() - startedAt);
    throw error;
  }
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
export function extractDeep(options: DeepExtractOptions): Promise<string> {
  const key = requestKey(options);
  const existing = deepInFlight.get(key);
  if (existing) return existing;
  const promise = extractDeepOnce(options).finally(() => deepInFlight.delete(key));
  deepInFlight.set(key, promise);
  return promise;
}

async function extractDeepOnce(options: DeepExtractOptions): Promise<string> {
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
      let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;

      try {
        await validateTargetUrl(url);
        await globalRateLimiter.throttle(url);
        const browser = await getBrowser(proxy);

        context = await browser.newContext({
          userAgent:
            headers?.["User-Agent"] ||
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          viewport: { width: 1920, height: 1080 },
          locale: "en-US",
          timezoneId: "Europe/London",
        });

        await context.addInitScript(getStealthInit());

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

        if (cssSelector) {
          await page.locator(cssSelector).first().waitFor({ state: "attached", timeout: Math.min(timeoutMs, 3000) }).catch(() => {});
        } else {
          await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 3000) }).catch(() => {});
        }

        const renderedHtml = await page.content();
        const status = response ? response.status() : 200;

        const antiBotCheck = detectAntiBot(status, renderedHtml);
        if (antiBotCheck.isBlocked) {
          throw new Error(`Anti-Bot protection triggered in deep crawl: ${antiBotCheck.reason}`);
        }

        return processHtmlToMarkdown(renderedHtml, { url, cssSelector });
      } finally {
        await context?.close().catch(() => {});
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
  return extractMetadataFromDocument(dom.window.document);
}

function extractMetadataFromDocument(document: Document): PageMetadata {

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
        let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
        try {
          await validateTargetUrl(url);
          await globalRateLimiter.throttle(url);
          const browser = await getBrowser(proxy);
          context = await browser.newContext({
            userAgent:
              headers?.["User-Agent"] ||
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport: { width: 1920, height: 1080 },
            locale: "en-US",
            timezoneId: "Europe/London",
          });

          // Stealth: patch the JS fingerprint before any page script runs, so
          // Cloudflare sees a "human-like" surface instead of a headless one.
          await context.addInitScript(getStealthInit());
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
          await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 3000) }).catch(() => {});
          const renderedHtml = await page.content();
          const status = response ? response.status() : 200;
          const antiBotCheck = detectAntiBot(status, renderedHtml);
          if (antiBotCheck.isBlocked) {
            throw new Error(`Anti-Bot protection triggered in deep crawl: ${antiBotCheck.reason}`);
          }
          return renderedHtml;
        } finally {
          await context?.close().catch(() => {});
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

  const dom = new JSDOM(rawHtml, { url });
  const document = dom.window.document;
  const metadata = includeMetadata ? extractMetadataFromDocument(document) : undefined;

  let data: Record<string, string | string[]> | undefined = undefined;

  if (schema && Object.keys(schema).length > 0) {
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

  const markdown = processDocumentToMarkdown(document, cssSelector);

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
        const canCache = !headers && !cookies && !proxy;
        const cacheKey = buildCacheKey({ url: targetUrl, mode, cssSelector });
        if (canCache) {
          const cached = getCachedPage(cacheKey);
          if (cached !== null) {
            const charCount = cached.length;
            results.push({
              url: targetUrl,
              success: true,
              markdown: cached,
              charCount,
              estimatedTokens: Math.ceil(charCount / 4),
            });
            continue;
          }
        }

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
        if (canCache) setCachedPage(cacheKey, markdown);
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
