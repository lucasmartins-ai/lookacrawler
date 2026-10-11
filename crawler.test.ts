import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { mapWebsite, crawlWebsite } from "./crawler.js";

describe("Autonomous Web Crawler & Mapper (crawler.ts)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let serverUrl: string;
  const requestLog: Array<{ path: string; start: number; end?: number }> = [];
  let inFlight = 0;
  let maxInFlight = 0;

  beforeAll(() => {
    process.env.LOOKACRAWLER_ALLOW_LOCAL = "true";
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname.startsWith("/pool/")) {
          const entry: { path: string; start: number; end?: number } = { path: url.pathname, start: performance.now() };
          requestLog.push(entry);
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (url.pathname === "/pool/slow") await Bun.sleep(1500);
          inFlight--;
          entry.end = performance.now();
          const links =
            url.pathname === "/pool/hub"
              ? ["slow", "f1", "f2", "f3"].map((p) => `<a href="/pool/${p}">${p}</a>`).join("")
              : "";
          return new Response(
            `<!DOCTYPE html><html><body><h1>${url.pathname}</h1><p>Pool test page content.</p>${links}</body></html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }

        if (url.pathname === "/robots.txt") {
          return new Response(
            `User-agent: *\nAllow: /\nSitemap: ${serverUrl}/sitemap.xml\n`,
            { headers: { "Content-Type": "text/plain" } }
          );
        }

        if (url.pathname === "/sitemap.xml") {
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?>
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url>
                <loc>${serverUrl}/page1</loc>
                <lastmod>2026-09-01</lastmod>
              </url>
              <url>
                <loc>${serverUrl}/page2</loc>
                <lastmod>2026-09-02</lastmod>
              </url>
              <url>
                <loc>${serverUrl}/private/admin</loc>
              </url>
              <url>
                <loc>https://external-domain.com/outside</loc>
              </url>
            </urlset>`,
            { headers: { "Content-Type": "application/xml" } }
          );
        }

        if (url.pathname === "/") {
          return new Response(
            `<!DOCTYPE html>
            <html>
              <body>
                <h1>Home Page</h1>
                <a href="/about">About Us</a>
                <a href="/contact">Contact</a>
                <a href="https://external-domain.com/link">External Link</a>
              </body>
            </html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }

        if (url.pathname === "/page1") {
          return new Response(
            `<!DOCTYPE html>
            <html>
              <body>
                <h1>Page 1 Content</h1>
                <p>Welcome to page one of the crawl test suite.</p>
                <a href="/page1/subpage">Page 1 Subpage</a>
              </body>
            </html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }

        if (url.pathname === "/page1/subpage") {
          return new Response(
            `<!DOCTYPE html>
            <html>
              <body>
                <h1>Subpage of Page 1</h1>
                <p>Deep nested subpage content.</p>
              </body>
            </html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }

        if (url.pathname === "/page2") {
          return new Response(
            `<!DOCTYPE html>
            <html>
              <body>
                <h1>Page 2</h1>
                <p>Content of page two.</p>
              </body>
            </html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }

        if (url.pathname === "/about") {
          return new Response(
            `<!DOCTYPE html>
            <html>
              <body>
                <h1>About Us</h1>
                <p>We are building LookaCrawler.</p>
              </body>
            </html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }

        if (url.pathname === "/contact") {
          return new Response(
            `<!DOCTYPE html>
            <html>
              <body>
                <h1>Contact Page</h1>
                <p>Contact information.</p>
              </body>
            </html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    serverUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    delete process.env.LOOKACRAWLER_ALLOW_LOCAL;
    server.stop(true);
  });

  describe("mapWebsite", () => {
    test("should discover URLs declared in sitemap.xml referenced by robots.txt", async () => {
      const result = await mapWebsite({
        url: serverUrl,
        maxUrls: 50,
      });

      expect(result.host).toBe("localhost");
      expect(result.sitemapsFound.length).toBeGreaterThan(0);
      const urls = result.urls.map((u) => u.url);
      expect(urls).toContain(`${serverUrl}/page1`);
      expect(urls).toContain(`${serverUrl}/page2`);
      // Should filter out external domain
      expect(urls).not.toContain("https://external-domain.com/outside");
    });

    test("should filter discovered URLs using excludePatterns and includePatterns", async () => {
      const result = await mapWebsite({
        url: serverUrl,
        includePatterns: ["page"],
        excludePatterns: ["admin"],
        maxUrls: 10,
      });

      const urls = result.urls.map((u) => u.url);
      expect(urls).toContain(`${serverUrl}/page1`);
      expect(urls).toContain(`${serverUrl}/page2`);
      expect(urls).not.toContain(`${serverUrl}/private/admin`);
    });

    test("should respect maxUrls boundary", async () => {
      const result = await mapWebsite({
        url: serverUrl,
        maxUrls: 1,
      });

      expect(result.urls.length).toBe(1);
    });
  });

  describe("crawlWebsite", () => {
    test("should recursively crawl pages within depth boundaries and compute token accounting", async () => {
      const result = await crawlWebsite({
        startUrl: `${serverUrl}/page1`,
        maxDepth: 1,
        maxPages: 5,
        mode: "fast",
      });

      expect(result.totalPagesCrawled).toBeGreaterThanOrEqual(1);
      expect(result.totalEstimatedTokens).toBeGreaterThan(0);

      const crawledUrls = result.pages.map((p) => p.url);
      expect(crawledUrls).toContain(`${serverUrl}/page1`);
      expect(crawledUrls).toContain(`${serverUrl}/page1/subpage`);

      const rootPage = result.pages.find((p) => p.url === `${serverUrl}/page1`);
      expect(rootPage?.depth).toBe(0);
      expect(rootPage?.markdown).toContain("Page 1 Content");
    });

    test("should enforce maxPages cutoff even if more links exist", async () => {
      const result = await crawlWebsite({
        startUrl: serverUrl,
        maxDepth: 2,
        maxPages: 2,
        mode: "fast",
      });

      expect(result.pages.length).toBeLessThanOrEqual(2);
    });

    test("should refill a crawl slot as soon as a page finishes instead of waiting for the batch", async () => {
      const result = await crawlWebsite({
        startUrl: `${serverUrl}/pool/hub`,
        maxDepth: 1,
        maxPages: 5,
        concurrency: 2,
        mode: "fast",
      });

      expect(result.pages.length).toBe(5);
      expect(maxInFlight).toBeLessThanOrEqual(2);

      // With fixed waves, /pool/f2 only started after /pool/slow returned.
      const slow = requestLog.find((r) => r.path === "/pool/slow")!;
      const f2 = requestLog.find((r) => r.path === "/pool/f2")!;
      expect(f2.start).toBeLessThan(slow.end!);
    });

    test("should support linkFormat: 'references' during crawling", async () => {
      const result = await crawlWebsite({
        startUrl: `${serverUrl}/page1`,
        maxDepth: 0,
        maxPages: 1,
        mode: "fast",
        linkFormat: "references",
      });

      expect(result.pages.length).toBe(1);
      const markdown = result.pages[0].markdown;
      expect(markdown).toContain("[1]:");
    });
  });
});
