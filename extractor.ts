import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
// @ts-ignore - plugin lacks official types
import { gfm } from "turndown-plugin-gfm";
import type { Browser, Page, Response as PlaywrightResponse } from "playwright";
import {
  detectAntiBot,
  globalRateLimiter,
  retryWithBackoff,
  proxyPool,
  type AntiBotCheckResult,
} from "./resilience.js";
import { getBrowser, getStealthInit } from "./browser-manager.js";
import { getMaxResponseBytes, isLocalAccessAllowed, validateProxyUrl, validateTargetUrl } from "./security.js";
import { BLOCKED_HEADER, getEgressGuard } from "./egress-guard.js";
import { buildCacheKey, getCachedPage, setCachedPage } from "./cache.js";
import { recordMetric } from "./metrics.js";

function hasEntries(obj?: Record<string, any>): boolean {
  return Boolean(obj && Object.keys(obj).length > 0);
}

export type LinkFormat = "inline" | "references" | "strip";
export type ImageMode = "ignore" | "alt_only" | "markdown";

const MAX_ACTIONS = 20;
const ACTIONS_TOTAL_MS = 30_000;

export type PageAction =
  | { type: "click"; selector: string; timeoutMs?: number }
  | { type: "scroll"; direction?: "up" | "down"; pixels?: number }
  | { type: "wait"; milliseconds: number }
  | { type: "fill"; selector: string; value: string };

export interface FastExtractOptions {
  url: string;
  cssSelector?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  proxy?: string;
  maxRetries?: number;
  linkFormat?: LinkFormat;
  imageMode?: ImageMode;
}

export interface DeepExtractOptions {
  url: string;
  cssSelector?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  proxy?: string;
  maxRetries?: number;
  linkFormat?: LinkFormat;
  imageMode?: ImageMode;
  actions?: PageAction[];
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

/** Headers that carry caller credentials and must not follow a cross-origin redirect. */
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
const SAFE_CROSS_ORIGIN_HEADERS = new Set(["user-agent", "accept", "accept-language", "accept-encoding"]);

/**
 * Drop credentials before following a redirect to another origin: the Cookie
 * and Authorization headers plus any custom header the caller supplied (API
 * keys often travel in headers such as X-Api-Key).
 */
function stripCredentialHeaders(
  current: Record<string, string>,
  userHeaders: Record<string, string>
): Record<string, string> {
  const userSupplied = new Set(Object.keys(userHeaders).map((h) => h.toLowerCase()));
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(current)) {
    const lower = name.toLowerCase();
    if (CREDENTIAL_HEADERS.has(lower)) continue;
    if (userSupplied.has(lower) && !SAFE_CROSS_ORIGIN_HEADERS.has(lower)) continue;
    next[name] = value;
  }
  return next;
}

/**
 * Decode an HTML body with its declared charset (TextDecoder() alone assumes
 * UTF-8 and garbles ISO-8859-1 / windows-1252 pages, common on Brazilian
 * sites). Order: BOM, Content-Type charset, <meta> in the first 2 KB, UTF-8.
 */
export function decodeHtml(body: Uint8Array, contentType: string | null): string {
  const decode = (label: string) => {
    try {
      return new TextDecoder(label).decode(body);
    } catch {
      return new TextDecoder().decode(body); // unknown label
    }
  };
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return decode("utf-8");
  if (body[0] === 0xff && body[1] === 0xfe) return decode("utf-16le");
  if (body[0] === 0xfe && body[1] === 0xff) return decode("utf-16be");
  const fromHeader = contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  if (fromHeader) return decode(fromHeader);
  const head = new TextDecoder("windows-1252").decode(body.subarray(0, 2048));
  return decode(head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i)?.[1] || "utf-8");
}

/** Read a response body as text, aborting as soon as it grows past `maxBytes`. */
async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response exceeds maximum size of ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return decodeHtml(Buffer.concat(chunks), response.headers.get("content-type"));
}

/** Validate a caller-supplied proxy, or fall back to the operator's proxy pool. */
async function selectProxy(proxy?: string): Promise<string | undefined> {
  if (proxy && proxy.trim()) return validateProxyUrl(proxy);
  return proxyPool.getProxy();
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

    // An explicit --proxy always wins (after validation); otherwise pull the
    // next entry from the operator's LOOKACRAWLER_PROXIES pool. Traffic goes
    // through the local egress guard, which pins every connection to the IP it
    // validated (no DNS rebinding, no redirect tricks) and chains the proxy, if
    // any, behind it. LOOKACRAWLER_ALLOW_LOCAL=true talks to the proxy directly.
    const effectiveProxy = await selectProxy(proxy);
    if (isLocalAccessAllowed()) {
      if (effectiveProxy) fetchOpts.proxy = effectiveProxy;
    } else {
      fetchOpts.proxy = (await getEgressGuard(effectiveProxy)).url;
    }
    // MITM-intercepting proxies (corporate TLS inspection, some residential
    // providers) present a forged cert. Bun has no per-request TLS knob we can
    // trust, so this is process-wide and opt-in — never the default.
    // ponytail: one env var, no config file. Split per-request when Bun exposes it.
    if (process.env.LOOKACRAWLER_INSECURE_TLS === "true") {
      fetchOpts.tls = { rejectUnauthorized: false };
    }

    let currentUrl = url;
    let response: Response | undefined;
    for (let redirect = 0; redirect <= 5; redirect++) {
      response = await fetch(currentUrl, { ...fetchOpts, redirect: "manual" });
      if (response.headers.get(BLOCKED_HEADER)) {
        throw new Error("Requests to private or local hosts are not allowed");
      }
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location || redirect === 5) throw new Error(`HTTP ${response.status}: redirect limit exceeded`);
      await response.body?.cancel().catch(() => {});
      const nextUrl = new URL(location, currentUrl).toString();
      await validateTargetUrl(nextUrl);
      if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
        // Same rule browsers apply: credentials the caller scoped to one site
        // must not be replayed to whatever host a redirect points at.
        fetchOpts.headers = stripCredentialHeaders(fetchOpts.headers, headers);
      }
      currentUrl = nextUrl;
      await globalRateLimiter.throttle(currentUrl);
    }
    if (!response) throw new Error("Request did not return a response");
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > getMaxResponseBytes()) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Response exceeds maximum size of ${getMaxResponseBytes()} bytes`);
    }
    // Content-Length is optional (chunked responses) and can lie, so enforce
    // the cap while streaming instead of buffering the whole body first.
    const htmlText = await readBodyWithLimit(response, getMaxResponseBytes());
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
interface TurndownPipelineOptions {
  imageMode?: ImageMode;
  linkFormat?: LinkFormat;
  references?: string[];
}

function createTurndownService(opts: TurndownPipelineOptions = {}): TurndownService {
  const { imageMode = "ignore", linkFormat = "inline", references = [] } = opts;
  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
  });

  // Enable GitHub-Flavored Markdown tables
  turndownService.use(gfm);

  // Configure image handling
  if (imageMode === "ignore") {
    turndownService.addRule("ignore-images", {
      filter: ["img"],
      replacement: () => "",
    });
  } else if (imageMode === "alt_only") {
    turndownService.addRule("alt-only-images", {
      filter: ["img"],
      replacement: (_, node) => {
        const alt = (node as HTMLElement).getAttribute("alt")?.trim();
        return alt ? `\n\n> 🖼️ *[Imagem: ${alt}]*\n\n` : "";
      },
    });
  } else if (imageMode === "markdown") {
    turndownService.addRule("keep-images", {
      filter: ["img"],
      replacement: (_, node) => {
        const alt = (node as HTMLElement).getAttribute("alt") || "";
        const src = (node as HTMLElement).getAttribute("src") || "";
        return src ? `![${alt}](${src})` : "";
      },
    });
  }

  // Configure link formatting
  if (linkFormat === "strip") {
    turndownService.addRule("strip-links", {
      filter: ["a"],
      replacement: (content) => content,
    });
  } else if (linkFormat === "references") {
    const refMap = new Map<string, number>();
    turndownService.addRule("reference-links", {
      filter: ["a"],
      replacement: (content, node) => {
        const href = (node as HTMLElement).getAttribute("href")?.trim();
        if (!href) return content;
        let idx = refMap.get(href);
        if (!idx) {
          references.push(href);
          idx = references.length;
          refMap.set(href, idx);
        }
        return `${content} [${idx}]`;
      },
    });
  }

  return turndownService;
}

/**
 * Prune high link-density container blocks (social links, footer links, tag dumps)
 */
function pruneHighLinkDensityElements(document: Document): void {
  const candidates = Array.from(document.querySelectorAll("div, section, aside, ul, ol"));
  for (const el of candidates) {
    const tag = el.tagName.toLowerCase();
    if (tag === "main" || tag === "article" || el.id === "content" || el.id === "main") continue;
    
    // Calculate actual non-whitespace character volume
    const totalChars = (el.textContent || "").replace(/\s+/g, "").length;
    if (totalChars < 15) continue;

    const links = Array.from(el.querySelectorAll("a"));
    if (links.length < 3) continue;

    const linkChars = links.reduce(
      (sum, link) => sum + (link.textContent || "").replace(/\s+/g, "").length,
      0
    );

    const ratio = totalChars > 0 ? linkChars / totalChars : 0;
    if (ratio >= 0.8) {
      el.remove();
    }
  }
}

/**
 * Shared Token-Optimization Pipeline:
 * JSDOM parsing -> Aggressive DOM Pruning -> CSS Selector scoping -> Readability -> Turndown Markdown
 */
export function processHtmlToMarkdown(
  rawHtml: string,
  options: {
    url: string;
    cssSelector?: string;
    linkFormat?: LinkFormat;
    imageMode?: ImageMode;
  }
): string {
  const { url, cssSelector, linkFormat = "inline", imageMode = "ignore" } = options;
  const dom = new JSDOM(rawHtml, { url });
  return processDocumentToMarkdown(dom.window.document, cssSelector, url, linkFormat, imageMode);
}

/** Below this, a pruned result is treated as "the heuristic may have eaten the page". */
const MIN_USEFUL_MARKDOWN_CHARS = 200;

function processDocumentToMarkdown(
  document: Document,
  cssSelector?: string,
  baseUrl?: string,
  linkFormat: LinkFormat = "inline",
  imageMode: ImageMode = "ignore"
): string {
  // Link-density pruning drops menus, but on link-heavy pages (news homepages,
  // where every headline card is an <a>) it removes the content itself and
  // returns nothing. Keep an untouched copy and fall back to it in that case.
  const unpruned = document.cloneNode(true) as Document;
  const markdown = renderDocument(document, cssSelector, baseUrl, linkFormat, imageMode, true);
  if (markdown.length >= MIN_USEFUL_MARKDOWN_CHARS) return markdown;
  const fallback = renderDocument(unpruned, cssSelector, baseUrl, linkFormat, imageMode, false);
  // Only when pruning removed most of the page; a small page losing its tag cloud is fine.
  return markdown.length < fallback.length * 0.25 ? fallback : markdown;
}

function renderDocument(
  document: Document,
  cssSelector: string | undefined,
  baseUrl: string | undefined,
  linkFormat: LinkFormat,
  imageMode: ImageMode,
  pruneLinks: boolean
): string {
  // 1. Resolve relative URLs to absolute URLs
  if (baseUrl) {
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      try {
        const href = a.getAttribute("href");
        if (
          href &&
          !href.startsWith("#") &&
          !href.startsWith("mailto:") &&
          !href.startsWith("tel:") &&
          !href.startsWith("javascript:")
        ) {
          a.setAttribute("href", new URL(href, baseUrl).toString());
        }
      } catch {
        /* keep original on invalid URL */
      }
    }

    for (const img of Array.from(document.querySelectorAll("img[src]"))) {
      try {
        const src = img.getAttribute("src");
        if (src && !src.startsWith("data:")) {
          img.setAttribute("src", new URL(src, baseUrl).toString());
        }
      } catch {
        /* keep original */
      }
    }
  }

  // 2. Aggressive DOM Pruning (Token Economy)
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

  // 3. Prune high link density boilerplate
  if (pruneLinks) pruneHighLinkDensityElements(document);

  const references: string[] = [];
  const turndownService = createTurndownService({ imageMode, linkFormat, references });

  // 4. Targeted Extraction (CSS Selector)
  if (cssSelector) {
    const targetNode = document.querySelector(cssSelector);
    if (targetNode) {
      let markdown = turndownService.turndown(targetNode.outerHTML);
      if (linkFormat === "references" && references.length > 0) {
        markdown += "\n\n---\n### Referências\n" + references.map((u, i) => `[${i + 1}]: ${u}`).join("\n");
      }
      return markdown.replace(/\n{3,}/g, "\n\n").trim();
    }
  }

  // 5. Readability & Turndown
  let cleanHtml = "";
  const reader = new Readability(document);
  const article = reader.parse();

  if (article && article.content) {
    cleanHtml = article.content;
  } else {
    cleanHtml = document.body ? document.body.innerHTML : "";
  }

  let markdown = turndownService.turndown(cleanHtml);
  if (linkFormat === "references" && references.length > 0) {
    markdown += "\n\n---\n### Referências\n" + references.map((u, i) => `[${i + 1}]: ${u}`).join("\n");
  }

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
  const { url, cssSelector, timeoutMs, headers, cookies, proxy, maxRetries = 3, linkFormat, imageMode } = options;

  recordMetric("requests");
  const startedAt = Date.now();
  try {
    const result = await retryWithBackoff(
    async () => {
      const rawHtml = await fetchHtml(url, { timeoutMs, headers, cookies, proxy });
      return processHtmlToMarkdown(rawHtml, { url, cssSelector, linkFormat, imageMode });
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
        linkFormat,
        imageMode,
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
 *
 * `sub_frame` is allowed deliberately: Cloudflare Turnstile, hCaptcha and
 * reCAPTCHA v3 render inside an iframe, and aborting it guarantees the
 * challenge never loads, so the page never resolves and the escalation to
 * `deep` is wasted. Stylesheets stay blocked (they are the bulk of the byte
 * savings) — the challenge widget brings its own inline styles.
 */
const ALLOWED_RESOURCE_TYPES = new Set([
  "document",
  "script",
  "fetch",
  "xhr",
  "sub_frame",
]);

/**
 * Install the per-page request handler used by every deep (browser) fetch:
 *  - aborts resource types we never need (images, CSS, fonts, media);
 *  - runs the SSRF check on *every* request, not only navigations;
 *  - injects caller headers (often Authorization / API keys) only into
 *    requests for the target's own origin. `setExtraHTTPHeaders` would hand
 *    them to every third-party script, pixel and CDN on the page.
 *
 * Redirect hops after a credentialed request are deliberately not given the
 * headers again (so a same-origin redirect loses them too — safe default).
 *
 * Playwright does not call this handler for redirect hops, so a 302 to an
 * internal address is stopped by the egress guard the browser is routed
 * through (see egress-guard.ts) and by `assertSafeNavigation`.
 */
async function installRequestGuard(
  page: Page,
  targetUrl: string,
  headers?: Record<string, string>
): Promise<void> {
  const targetOrigin = new URL(targetUrl).origin;
  const injected = Object.fromEntries(
    Object.entries(headers || {}).filter(([name]) => name.toLowerCase() !== "user-agent")
  );
  const hasInjected = Object.keys(injected).length > 0;

  await page.route("**/*", async (route) => {
    const req = route.request();
    if (!ALLOWED_RESOURCE_TYPES.has(req.resourceType())) {
      return route.abort();
    }
    try {
      await validateTargetUrl(req.url());
    } catch {
      return route.abort("blockedbyclient");
    }
    if (hasInjected && new URL(req.url()).origin === targetOrigin) {
      // Headers passed to route.continue() also ride along on every redirect
      // hop, including one to a different origin. Fetch this request without
      // following redirects instead and hand the 3xx back to the browser,
      // which then follows it *without* the caller's credentials. The fetch
      // runs through the same browser proxy (egress guard) as everything else.
      try {
        const response = await route.fetch({ headers: { ...req.headers(), ...injected }, maxRedirects: 0 });
        return route.fulfill({ response });
      } catch {
        return route.abort("failed");
      }
    }
    return route.continue();
  });
}

/**
 * Defence in depth for setups that bypass the egress guard (explicit proxy):
 * refuse content whose redirect chain or final URL is a forbidden host.
 */
async function assertSafeNavigation(page: Page, response: PlaywrightResponse | null): Promise<void> {
  if (response && (await response.headerValue(BLOCKED_HEADER).catch(() => null))) {
    throw new Error("Requests to private or local hosts are not allowed");
  }
  for (let r = response?.request() ?? null; r; r = r.redirectedFrom()) {
    await validateTargetUrl(r.url());
  }
  await validateTargetUrl(page.url());
}

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
    linkFormat,
    imageMode,
    actions,
  } = options;

  recordMetric("requests");
  const startedAt = Date.now();

  try {
    const result = await retryWithBackoff(
      async () => {
        let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;

        try {
          await validateTargetUrl(url);
          await globalRateLimiter.throttle(url);
          const browser = await getBrowser(proxyPool.getProxy(proxy));

          context = await browser.newContext({
            // A service worker could fetch on the page's behalf outside the request guard.
            serviceWorkers: "block",
            // Mirrors LOOKACRAWLER_INSECURE_TLS: needed only behind a
            // TLS-intercepting proxy, never by default.
            ...(process.env.LOOKACRAWLER_INSECURE_TLS === "true" ? { ignoreHTTPSErrors: true } : {}),
            userAgent:
              headers?.["User-Agent"] ||
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport: { width: 1920, height: 1080 },
            locale: "en-US",
            timezoneId: "Europe/London",
          });

          // Install stealth script to spoof fingerprint before any page script executes
          await context.addInitScript(getStealthInit());

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

          await installRequestGuard(page, url, headers);

          const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: timeoutMs,
          });
          await assertSafeNavigation(page, response);

          if (cssSelector) {
            await page.locator(cssSelector).first().waitFor({ state: "attached", timeout: Math.min(timeoutMs, 3000) }).catch(() => {});
          } else {
            await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 3000) }).catch(() => {});
          }

          // Execute pre-crawl automation actions if defined (e.g. cookie consent, load more, scrolling)
          if (actions && actions.length > 0) {
            // Bounded so one request cannot hold a browser context indefinitely
            // (the MCP schema enforces the same caps; this covers library callers).
            const deadline = Date.now() + ACTIONS_TOTAL_MS;
            for (const act of actions.slice(0, MAX_ACTIONS)) {
              const left = deadline - Date.now();
              if (left <= 0) break;
              const stepMs = Math.min(3000, left);
              try {
                if (act.type === "click" && act.selector) {
                  await page.waitForSelector(act.selector, { timeout: Math.min(act.timeoutMs || 3000, stepMs) }).catch(() => {});
                  await page.click(act.selector, { timeout: stepMs }).catch(() => {});
                } else if (act.type === "scroll") {
                  const px = Math.min(Math.max(act.pixels ?? 800, 0), 20000);
                  const dy = act.direction === "up" ? -px : px;
                  await page.evaluate((y) => window.scrollBy({ top: y, behavior: "smooth" }), dy);
                  await page.waitForTimeout(Math.min(400, left));
                } else if (act.type === "wait" && act.milliseconds) {
                  await page.waitForTimeout(Math.min(act.milliseconds, 10000, left));
                } else if (act.type === "fill" && act.selector) {
                  await page.waitForSelector(act.selector, { timeout: stepMs }).catch(() => {});
                  await page.fill(act.selector, act.value || "", { timeout: stepMs }).catch(() => {});
                }
              } catch {
                /* non-critical action failure */
              }
            }
          }

          const renderedHtml = await page.content();
          const status = response ? response.status() : 200;

          const antiBotCheck = detectAntiBot(status, renderedHtml);
          if (antiBotCheck.isBlocked) {
            throw new Error(`Anti-Bot protection triggered in deep crawl: ${antiBotCheck.reason}`);
          }

          recordMetric("bytesFetched", Buffer.byteLength(renderedHtml, "utf8"));
          return processHtmlToMarkdown(renderedHtml, { url, cssSelector, linkFormat, imageMode });
        } finally {
          await context?.close().catch(() => {});
        }
      },
      { maxRetries }
    );

    recordMetric("successes");
    recordMetric("durationMs", Date.now() - startedAt);
    return result;
  } catch (error) {
    recordMetric("failures");
    recordMetric("durationMs", Date.now() - startedAt);
    throw error;
  }
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
  jsonLd?: any[];
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

  // Extract application/ld+json structured schema blocks
  const jsonLdScripts = Array.from(
    document.querySelectorAll("script[type='application/ld+json']")
  );
  const jsonLd: any[] = [];
  for (const s of jsonLdScripts) {
    try {
      const text = s.textContent?.trim();
      if (text) jsonLd.push(JSON.parse(text));
    } catch {
      /* ignore invalid JSON */
    }
  }

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
    jsonLd: jsonLd.length > 0 ? jsonLd : undefined,
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
          const browser = await getBrowser(proxyPool.getProxy(proxy));
          context = await browser.newContext({
            // A service worker could fetch on the page's behalf outside the request guard.
            serviceWorkers: "block",
            // Mirrors LOOKACRAWLER_INSECURE_TLS: needed only behind a
            // TLS-intercepting proxy, never by default.
            ...(process.env.LOOKACRAWLER_INSECURE_TLS === "true" ? { ignoreHTTPSErrors: true } : {}),
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
          await installRequestGuard(page, url, headers);
          const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: timeoutMs,
          });
          await assertSafeNavigation(page, response);
          await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 3000) }).catch(() => {});
          await validateTargetUrl(page.url());
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

    for (const [key, rawSelector] of Object.entries(schema)) {
      let selector = rawSelector.trim();
      let attr: string | undefined;
      const atIndex = selector.indexOf("@");
      if (atIndex !== -1) {
        attr = selector.slice(atIndex + 1).trim();
        selector = selector.slice(0, atIndex).trim();
      }

      const elements = Array.from(document.querySelectorAll(selector));
      const getVal = (el: Element): string => {
        if (attr) {
          return el.getAttribute(attr)?.trim() || "";
        }
        if (el.tagName === "A" && el.hasAttribute("href")) {
          return el.getAttribute("href")?.trim() || el.textContent?.trim() || "";
        }
        if (el.tagName === "IMG" && el.hasAttribute("src")) {
          return el.getAttribute("src")?.trim() || "";
        }
        return el.textContent?.trim() || "";
      };

      if (elements.length === 0) {
        data[key] = "";
      } else if (elements.length === 1) {
        data[key] = getVal(elements[0]);
      } else {
        data[key] = elements.map(getVal).filter(Boolean);
      }
    }
  }

  const markdown = processDocumentToMarkdown(document, cssSelector, url);

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

  const results: BatchItemResult[] = new Array(urls.length);
  const queue = urls.map((url, index) => ({ url, index }));

  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { url: targetUrl, index } = item;

      try {
        const canCache = !hasEntries(headers) && !hasEntries(cookies) && !proxy;
        const cacheKey = buildCacheKey({ url: targetUrl, mode, cssSelector });
        if (canCache) {
          const cached = getCachedPage(cacheKey);
          if (cached !== null) {
            const charCount = cached.length;
            results[index] = {
              url: targetUrl,
              success: true,
              markdown: cached,
              charCount,
              estimatedTokens: Math.ceil(charCount / 4),
            };
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

        results[index] = {
          url: targetUrl,
          success: true,
          markdown,
          charCount,
          estimatedTokens,
        };
        if (canCache) setCachedPage(cacheKey, markdown);
      } catch (err: any) {
        results[index] = {
          url: targetUrl,
          success: false,
          error: err.message || String(err),
        };
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);

  const successful = results.filter((r) => r && r.success).length;
  const failed = results.filter((r) => r && !r.success).length;
  const totalCharCount = results.reduce((acc, r) => acc + (r?.charCount || 0), 0);
  const totalEstimatedTokens = results.reduce((acc, r) => acc + (r?.estimatedTokens || 0), 0);

  return {
    totalUrls: urls.length,
    successful,
    failed,
    totalCharCount,
    totalEstimatedTokens,
    results,
  };
}

// Re-export web mapping and recursive crawling capabilities
export {
  mapWebsite,
  crawlWebsite,
  type MapWebsiteOptions,
  type MapWebsiteResult,
  type DiscoveredUrl,
  type CrawlWebsiteOptions,
  type CrawlWebsiteResult,
  type CrawledPage,
} from "./crawler.js";

