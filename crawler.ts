import { JSDOM } from "jsdom";
import { extractFast, extractDeep, type LinkFormat, type ImageMode } from "./extractor.js";
import { validateTargetUrl } from "./security.js";
import { fetchHtml } from "./extractor.js";
import { loadRobots, type RobotsState } from "./robots.js";

export interface DiscoveredUrl {
  url: string;
  source: "sitemap" | "robots" | "html_link";
  lastmod?: string;
}

export interface MapWebsiteOptions {
  url: string;
  maxLinks?: number;
  maxUrls?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  timeoutMs?: number;
  /** Skip robots.txt Disallow/Allow rules (default: respected). */
  ignoreRobots?: boolean;
}

export interface MapWebsiteResult {
  host: string;
  sitemapsFound: string[];
  totalDiscovered: number;
  urls: DiscoveredUrl[];
  /** "applied", "none" (no robots.txt), "unreachable" (5xx/timeout: nothing allowed) or "ignored". */
  robots: RobotsState;
  /** Discovered URLs left out because robots.txt disallows them. */
  skippedByRobots: string[];
}

export interface CrawlWebsiteOptions {
  startUrl?: string;
  url?: string;
  maxDepth?: number;
  maxPages?: number;
  concurrency?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  mode?: "fast" | "deep";
  linkFormat?: LinkFormat;
  imageMode?: ImageMode;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  proxy?: string;
  timeoutMs?: number;
  /** Skip robots.txt Disallow/Allow rules (default: respected). */
  ignoreRobots?: boolean;
}

export interface CrawledPage {
  url: string;
  depth: number;
  markdown: string;
  charCount: number;
  estimatedTokens: number;
  error?: string;
}

export interface CrawlWebsiteResult {
  startUrl: string;
  totalPagesCrawled: number;
  totalEstimatedTokens: number;
  pages: CrawledPage[];
  robots: RobotsState;
  /** Links (and possibly the start URL) not fetched because robots.txt disallows them. */
  skippedByRobots: string[];
}

const MAX_URL_PATTERNS = 10;
const MAX_URL_PATTERN_LENGTH = 200;

/**
 * Compile include/exclude filters. Patterns are case-sensitive substrings where
 * `*` matches any run of characters; they are deliberately NOT regexes because
 * crawled URLs are attacker-controlled and a backtracking regex like
 * `^(([a-z/:.])+)+$` blocks the event loop for seconds (ReDoS).
 */
export function compileUrlPatterns(patterns: string[], kind: "include" | "exclude"): Array<(s: string) => boolean> {
  if (patterns.length > MAX_URL_PATTERNS) throw new Error(`Too many ${kind} patterns (max ${MAX_URL_PATTERNS})`);
  return patterns.map((p) => {
    if (p.length > MAX_URL_PATTERN_LENGTH) throw new Error(`${kind} pattern is too long (max ${MAX_URL_PATTERN_LENGTH} characters)`);
    // Fail loudly on old regex syntax: silently matching it literally would turn
    // an exclude like "logout|admin" into a no-op. ("?" and "+" stay legal: URLs use them.)
    if (/[\\^$()[\]{}|]|\.\*/.test(p)) {
      throw new Error(`Invalid ${kind} pattern "${p}": patterns are substrings where * is the only wildcard, not regexes`);
    }
    const parts = p.split("*").filter(Boolean);
    return (s: string) => {
      let at = 0;
      for (const part of parts) {
        const i = s.indexOf(part, at);
        if (i < 0) return false;
        at = i + part.length;
      }
      return true;
    };
  });
}

function makeUrlFilter(host: string, includePatterns: string[], excludePatterns: string[]): (candidate: string) => boolean {
  const include = compileUrlPatterns(includePatterns, "include");
  const exclude = compileUrlPatterns(excludePatterns, "exclude");
  return (candidate) => {
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname !== host) return false;
      const hit = (m: (s: string) => boolean) => m(parsed.pathname) || m(candidate);
      if (exclude.some(hit)) return false;
      return include.length === 0 || include.some(hit);
    } catch {
      return false;
    }
  };
}

/**
 * Discover the architecture and page inventory of a website via sitemaps, robots.txt, and link graphs.
 */
export async function mapWebsite(options: MapWebsiteOptions): Promise<MapWebsiteResult> {
  const { url, timeoutMs = 10000, includePatterns = [], excludePatterns = [] } = options;
  const maxLimit = options.maxUrls ?? options.maxLinks ?? 100;
  await validateTargetUrl(url);

  const parsedStart = new URL(url);
  const origin = parsedStart.origin;
  const sitemapsFound: string[] = [];
  const discoveredMap = new Map<string, DiscoveredUrl>();

  const passesFilter = makeUrlFilter(parsedStart.hostname, includePatterns, excludePatterns);
  const skippedByRobots = new Set<string>();

  // 1. robots.txt: declared sitemaps and the Disallow/Allow rules, one fetch.
  //    Sitemaps are read even with --ignore-robots: they are a URL source.
  const robots = await loadRobots(origin);
  sitemapsFound.push(...robots.sitemaps);
  const obeyRobots = !options.ignoreRobots;
  const isUrlAllowed = (candidate: string): boolean => {
    if (!passesFilter(candidate)) return false;
    if (obeyRobots && !robots.isAllowed(candidate)) {
      if (skippedByRobots.size < maxLimit) skippedByRobots.add(candidate);
      return false;
    }
    return true;
  };
  const allowRedirect = obeyRobots ? robots.isAllowed : undefined;

  // Fallback to default sitemap.xml if none detected
  if (sitemapsFound.length === 0) {
    sitemapsFound.push(`${origin}/sitemap.xml`);
  }

  // 2. Fetch and parse sitemaps
  for (const sitemapUrl of sitemapsFound) {
    if (discoveredMap.size >= maxLimit) break;
    // Covers the /sitemap.xml fallback when robots.txt disallows it or was unreachable.
    if (obeyRobots && !robots.isAllowed(sitemapUrl)) continue;
    try {
      await validateTargetUrl(sitemapUrl);
      const xmlContent = await fetchHtml(sitemapUrl, { timeoutMs, allowRedirect });
      const locRegex = /<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/gi;
      const lastmodRegex = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i;

      let locMatch: RegExpExecArray | null;
      while ((locMatch = locRegex.exec(xmlContent)) !== null) {
        const foundUrl = locMatch[1].trim();
        try {
          if (isUrlAllowed(foundUrl) && !discoveredMap.has(foundUrl)) {
            // Extract snippet for lastmod if present around loc
            const chunk = xmlContent.slice(locMatch.index, locMatch.index + 300);
            const lastmodMatch = chunk.match(lastmodRegex);
            discoveredMap.set(foundUrl, {
              url: foundUrl,
              source: "sitemap",
              lastmod: lastmodMatch ? lastmodMatch[1] : undefined,
            });
            if (discoveredMap.size >= maxLimit) break;
          }
        } catch {
          /* skip invalid URLs */
        }
      }
    } catch {
      /* sitemap fetch failed */
    }
  }

  // 3. If sitemaps yielded few links, parse links from root HTML page
  const homeAllowed = !obeyRobots || robots.isAllowed(url);
  if (!homeAllowed) skippedByRobots.add(url);
  if (discoveredMap.size < 10 && homeAllowed) {
    try {
      const homeHtml = await fetchHtml(url, { timeoutMs, allowRedirect });
      const dom = new JSDOM(homeHtml, { url });
      const anchors = Array.from(dom.window.document.querySelectorAll("a[href]"));

      for (const a of anchors) {
        if (discoveredMap.size >= maxLimit) break;
        const href = a.getAttribute("href");
        if (!href) continue;

        try {
          const resolved = new URL(href, url);
          if (resolved.protocol === "http:" || resolved.protocol === "https:") {
            resolved.hash = "";
            const cleanUrl = resolved.toString();
            if (isUrlAllowed(cleanUrl) && !discoveredMap.has(cleanUrl)) {
              discoveredMap.set(cleanUrl, {
                url: cleanUrl,
                source: "html_link",
              });
            }
          }
        } catch {
          /* ignore unparseable links */
        }
      }
    } catch (err) {
      // A redirect into a disallowed path is a robots skip, not a silent failure.
      const veto = /^Redirect to (\S+) is disallowed by robots\.txt/.exec(err instanceof Error ? err.message : "");
      if (veto) skippedByRobots.add(veto[1]);
    }
  }

  const urls = Array.from(discoveredMap.values()).slice(0, maxLimit);

  return {
    host: parsedStart.hostname,
    sitemapsFound,
    totalDiscovered: urls.length,
    urls,
    robots: obeyRobots ? robots.state : "ignored",
    skippedByRobots: Array.from(skippedByRobots),
  };
}

/**
 * Pull every outbound href out of an already-extracted markdown document.
 *
 * Covers both link formats we emit: inline `[text](url)` and the footnote
 * reference block (`[1]: https://...`) produced by `link_format: references`.
 * `strip` yields neither, which is why the caller falls back to a refetch.
 */
export function extractHrefsFromMarkdown(markdown: string): string[] {
  const hrefs: string[] = [];
  const inline = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(markdown)) !== null) {
    hrefs.push(m[1]);
  }
  const footnote = /^\[\d+\]:\s*(\S+)/gm;
  while ((m = footnote.exec(markdown)) !== null) {
    hrefs.push(m[1]);
  }
  return hrefs;
}

/**
 * Perform autonomous, recursive website crawling with depth boundaries, regex route filtering, and token accounting.
 */
export async function crawlWebsite(options: CrawlWebsiteOptions): Promise<CrawlWebsiteResult> {
  const startUrl = options.startUrl || options.url;
  if (!startUrl) {
    throw new Error("Missing startUrl for crawler");
  }
  const {
    maxDepth = 2,
    maxPages = 10,
    concurrency = 3,
    includePatterns = [],
    excludePatterns = [],
    mode = "fast",
    linkFormat,
    imageMode,
    headers,
    cookies,
    proxy,
    timeoutMs = 15000,
    ignoreRobots = false,
  } = options;

  await validateTargetUrl(startUrl);
  const targetHost = new URL(startUrl).hostname;

  const passesFilter = makeUrlFilter(targetHost, includePatterns, excludePatterns);
  const robots = await loadRobots(new URL(startUrl).origin, { ignore: ignoreRobots, headers, cookies, proxy });
  // Fast mode checks each redirect hop too; deep mode's browser follows redirects on its own.
  const allowRedirect = ignoreRobots ? undefined : robots.isAllowed;
  const skippedByRobots = new Set<string>();
  const isUrlAllowed = (candidate: string): boolean => {
    if (!passesFilter(candidate)) return false;
    if (!robots.isAllowed(candidate)) {
      skippedByRobots.add(candidate);
      return false;
    }
    return true;
  };

  const queue: Array<{ url: string; depth: number }> = [];
  const visited = new Set<string>([startUrl]);
  const pages: CrawledPage[] = [];
  // The start URL is the caller's choice, so only robots (not the include/exclude filters) can veto it.
  if (robots.isAllowed(startUrl)) queue.push({ url: startUrl, depth: 0 });
  else skippedByRobots.add(startUrl);

  const crawlPage = async ({ url: currentUrl, depth }: { url: string; depth: number }): Promise<void> => {
    try {
      let markdown: string;
      if (mode === "deep") {
        markdown = await extractDeep({
          url: currentUrl,
          timeoutMs,
          headers,
          cookies,
          proxy,
          linkFormat,
          imageMode,
        });
      } else {
        markdown = await extractFast({
          url: currentUrl,
          timeoutMs,
          headers,
          cookies,
          proxy,
          linkFormat,
          imageMode,
          allowRedirect,
        });
      }

      const charCount = markdown.length;
      const estimatedTokens = Math.ceil(charCount / 4);

      pages.push({
        url: currentUrl,
        depth,
        markdown,
        charCount,
        estimatedTokens,
      });

      // If depth allows, discover outgoing links from this page
      if (depth < maxDepth && pages.length + queue.length < maxPages * 2) {
        try {
          // Reuse the markdown we already have instead of re-fetching the
          // page. A second fetchHtml doubles the traffic and, in `deep`
          // mode, returns raw SPA markup with an empty <div id="root">, so
          // link discovery silently found nothing and the crawl stopped.
          // The rendered markdown carries every href the browser saw.
          let hrefs = extractHrefsFromMarkdown(markdown);
          if (hrefs.length === 0 && linkFormat === "strip") {
            // `strip` removes URLs by design; the page may still be worth
            // one extra fetch if it has no other way to expose its links.
            const html = await fetchHtml(currentUrl, { timeoutMs: 5000, headers, cookies, proxy, allowRedirect });
            const dom = new JSDOM(html, { url: currentUrl });
            hrefs = Array.from(dom.window.document.querySelectorAll("a[href]"))
              .map((a) => a.getAttribute("href") || "");
          }

          for (const href of hrefs) {
            if (!href) continue;
            try {
              const resolved = new URL(href, currentUrl);
              resolved.hash = "";
              const normalizedUrl = resolved.toString();

              if (!visited.has(normalizedUrl) && isUrlAllowed(normalizedUrl)) {
                visited.add(normalizedUrl);
                queue.push({ url: normalizedUrl, depth: depth + 1 });
              }
            } catch {
              /* skip */
            }
          }
        } catch {
          /* link discovery error ignored */
        }
      }
    } catch (err: any) {
      pages.push({
        url: currentUrl,
        depth,
        markdown: "",
        charCount: 0,
        estimatedTokens: 0,
        error: err.message || String(err),
      });
    }
  };

  // Worker pool: a slot is refilled as soon as its page finishes. Fixed-size
  // waves (`Promise.all` per batch) left every slot idle until the slowest page
  // of the batch returned.
  let inFlight = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (inFlight < concurrency && queue.length > 0 && pages.length + inFlight < maxPages) {
        const item = queue.shift()!;
        inFlight++;
        crawlPage(item).finally(() => {
          inFlight--;
          pump();
        });
      }
      if (inFlight === 0) resolve();
    };
    pump();
  });

  const totalEstimatedTokens = pages.reduce((sum, p) => sum + p.estimatedTokens, 0);

  return {
    startUrl,
    totalPagesCrawled: pages.length,
    totalEstimatedTokens,
    pages,
    robots: robots.state,
    skippedByRobots: Array.from(skippedByRobots),
  };
}
