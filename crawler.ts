import { JSDOM } from "jsdom";
import { extractFast, extractDeep, type LinkFormat, type ImageMode } from "./extractor.js";
import { validateTargetUrl } from "./security.js";
import { fetchHtml } from "./extractor.js";

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
}

export interface MapWebsiteResult {
  host: string;
  sitemapsFound: string[];
  totalDiscovered: number;
  urls: DiscoveredUrl[];
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

  const includeRegexes = includePatterns.map((p) => new RegExp(p));
  const excludeRegexes = excludePatterns.map((p) => new RegExp(p));

  function isUrlAllowed(candidate: string): boolean {
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname !== parsedStart.hostname) return false;
      const path = parsed.pathname;
      if (excludeRegexes.some((re) => re.test(path) || re.test(candidate))) return false;
      if (includeRegexes.length > 0 && !includeRegexes.some((re) => re.test(path) || re.test(candidate))) return false;
      return true;
    } catch {
      return false;
    }
  }

  // 1. Inspect robots.txt for declared sitemaps
  try {
    const robotsUrl = `${origin}/robots.txt`;
    const robotsTxt = await fetchHtml(robotsUrl, { timeoutMs: 5000 });
    const sitemapRegex = /Sitemap:\s*(https?:\/\/[^\s\r\n]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = sitemapRegex.exec(robotsTxt)) !== null) {
      const sitemapUrl = match[1].trim();
      if (!sitemapsFound.includes(sitemapUrl)) {
        sitemapsFound.push(sitemapUrl);
      }
    }
  } catch {
    /* robots.txt unavailable or blocked */
  }

  // Fallback to default sitemap.xml if none detected
  if (sitemapsFound.length === 0) {
    sitemapsFound.push(`${origin}/sitemap.xml`);
  }

  // 2. Fetch and parse sitemaps
  for (const sitemapUrl of sitemapsFound) {
    if (discoveredMap.size >= maxLimit) break;
    try {
      await validateTargetUrl(sitemapUrl);
      const xmlContent = await fetchHtml(sitemapUrl, { timeoutMs });
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
  if (discoveredMap.size < 10) {
    try {
      const homeHtml = await fetchHtml(url, { timeoutMs });
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
    } catch {
      /* home page fetch failed */
    }
  }

  const urls = Array.from(discoveredMap.values()).slice(0, maxLimit);

  return {
    host: parsedStart.hostname,
    sitemapsFound,
    totalDiscovered: urls.length,
    urls,
  };
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
  } = options;

  await validateTargetUrl(startUrl);
  const targetHost = new URL(startUrl).hostname;

  const includeRegexes = includePatterns.map((p) => new RegExp(p));
  const excludeRegexes = excludePatterns.map((p) => new RegExp(p));

  function isUrlAllowed(candidate: string): boolean {
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname !== targetHost) return false;
      const path = parsed.pathname;

      if (excludeRegexes.some((re) => re.test(path) || re.test(candidate))) {
        return false;
      }
      if (includeRegexes.length > 0 && !includeRegexes.some((re) => re.test(path) || re.test(candidate))) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  const visited = new Set<string>([startUrl]);
  const pages: CrawledPage[] = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const currentBatch = queue.splice(0, Math.min(concurrency, maxPages - pages.length));

    await Promise.all(
      currentBatch.map(async ({ url: currentUrl, depth }) => {
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
              const html = await fetchHtml(currentUrl, { timeoutMs: 5000, headers, cookies, proxy });
              const dom = new JSDOM(html, { url: currentUrl });
              const anchors = Array.from(dom.window.document.querySelectorAll("a[href]"));

              for (const a of anchors) {
                const href = a.getAttribute("href");
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
      })
    );
  }

  const totalEstimatedTokens = pages.reduce((sum, p) => sum + p.estimatedTokens, 0);

  return {
    startUrl,
    totalPagesCrawled: pages.length,
    totalEstimatedTokens,
    pages,
  };
}
