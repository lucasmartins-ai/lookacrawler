import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { extractFast, extractStructured, batchExtract } from "./extractor.js";
import { clearCache } from "./cache.js";

describe("Extractor Full End-to-End Integration Suite (extractor.ts)", () => {
  let server: any;
  let baseUrl: string;
  let flakyAttempts = 0;

  beforeAll(() => {
    process.env.LOOKACRAWLER_ALLOW_LOCAL = "true";
    clearCache();

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/article") {
          return new Response(
            `<!DOCTYPE html>
            <html lang="en">
              <head>
                <title>Integration Test Article</title>
                <meta name="description" content="A comprehensive test page for LookaCrawler">
                <meta property="og:title" content="OG Test Article Title">
                <meta property="og:description" content="OG Test Description">
                <meta property="og:image" content="/images/og.png">
                <link rel="canonical" href="${baseUrl}/canonical-article">
                <meta name="author" content="Looka Tester">
                <script type="application/ld+json">
                  {
                    "@context": "https://schema.org",
                    "@type": "NewsArticle",
                    "headline": "Integration Test Article",
                    "datePublished": "2026-09-04T12:00:00Z"
                  }
                </script>
              </head>
              <body>
                <header><nav><a href="/home">Home</a><a href="/about">About</a></nav></header>
                <main id="content">
                  <h1>Main Headline</h1>
                  <p>This is the first paragraph of the article with <a href="/docs/guide">relative documentation link</a>.</p>
                  
                  <h2>Performance Metrics</h2>
                  <table>
                    <thead>
                      <tr>
                        <th>Metric</th>
                        <th>Baseline</th>
                        <th>Optimized</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Latency</td>
                        <td>250ms</td>
                        <td>45ms</td>
                      </tr>
                      <tr>
                        <td>Tokens</td>
                        <td>4,000</td>
                        <td>850</td>
                      </tr>
                    </tbody>
                  </table>
                  
                  <div class="sidebar">
                    <p>Some noise inside sidebar.</p>
                  </div>
                </main>
                <footer>
                  <p>Copyright 2026 LookaCrawler. All rights reserved.</p>
                </footer>
              </body>
            </html>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }

        if (url.pathname === "/product") {
          return new Response(
            `<!DOCTYPE html>
            <html>
              <body>
                <div class="product-card">
                  <h1 class="title">Wireless Noise-Cancelling Headphones</h1>
                  <span class="price">$199.99</span>
                  <a class="cta-button" href="/checkout?item=123">Buy Now</a>
                  <img class="product-image" src="/static/headphones.jpg" alt="Headphones Thumbnail">
                </div>
              </body>
            </html>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }

        if (url.pathname === "/gated-content") {
          const auth = req.headers.get("Authorization");
          const cookie = req.headers.get("Cookie");

          if (auth === "Bearer secret-crawler-token" && cookie?.includes("session=valid-session-123")) {
            return new Response(
              `<html><body><main><h1>Confidential Document</h1><p>Unlocked secret content for authenticated agents.</p></main></body></html>`,
              { headers: { "Content-Type": "text/html; charset=utf-8" } }
            );
          }
          return new Response("Unauthorized", { status: 401 });
        }

        if (url.pathname === "/flaky-endpoint") {
          flakyAttempts++;
          if (flakyAttempts === 1) {
            return new Response("Service Temporarily Unavailable", { status: 503 });
          }
          return new Response("<html><body><h1>Recovered Content</h1><p>Successfully retrieved after retry.</p></body></html>", {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        if (url.pathname === "/page1") {
          return new Response("<html><body><h1>Page 1</h1><p>First concurrent page.</p></body></html>", {
            headers: { "Content-Type": "text/html" },
          });
        }
        if (url.pathname === "/page2") {
          return new Response("<html><body><h1>Page 2</h1><p>Second concurrent page.</p></body></html>", {
            headers: { "Content-Type": "text/html" },
          });
        }
        if (url.pathname === "/page3") {
          return new Response("<html><body><h1>Page 3</h1><p>Third concurrent page.</p></body></html>", {
            headers: { "Content-Type": "text/html" },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    delete process.env.LOOKACRAWLER_ALLOW_LOCAL;
    server.stop();
  });

  it("should extract article markdown, resolve relative URLs, and strip header/footer noise", async () => {
    const markdown = await extractFast({
      url: `${baseUrl}/article`,
    });

    expect(markdown).toContain("Main Headline");
    expect(markdown).toContain("Performance Metrics");
    // Relative link must be resolved to absolute baseUrl
    expect(markdown).toContain(`[relative documentation link](${baseUrl}/docs/guide)`);
    // GFM table columns
    expect(markdown).toContain("| Metric | Baseline | Optimized |");
    expect(markdown).toContain("| Latency | 250ms | 45ms |");
    // Noise elements should be eliminated
    expect(markdown).not.toContain("Copyright 2026 LookaCrawler");
    expect(markdown).not.toContain("Home");
    expect(markdown).not.toContain("About");
  });

  it("should scope extraction strictly to specified cssSelector", async () => {
    const markdown = await extractFast({
      url: `${baseUrl}/article`,
      cssSelector: "table",
    });

    expect(markdown).toContain("| Metric | Baseline | Optimized |");
    expect(markdown).not.toContain("Main Headline");
    expect(markdown).not.toContain("This is the first paragraph");
  });

  it("should extract structured data including attributes (@href, @src) and metadata (JSON-LD)", async () => {
    const res = await extractStructured({
      url: `${baseUrl}/article`,
      mode: "fast",
      schema: {
        heading: "h1",
        metricsTable: "table",
      },
      includeMetadata: true,
    });

    expect(res.url).toBe(`${baseUrl}/article`);
    expect(res.data?.heading).toBe("Main Headline");
    expect(res.metadata?.title).toBe("Integration Test Article");
    expect(res.metadata?.description).toBe("A comprehensive test page for LookaCrawler");
    expect(res.metadata?.ogTitle).toBe("OG Test Article Title");
    expect(res.metadata?.author).toBe("Looka Tester");
    expect(res.metadata?.jsonLd).toBeDefined();
    expect(Array.isArray(res.metadata?.jsonLd)).toBe(true);
    expect(res.metadata?.jsonLd?.[0]?.headline).toBe("Integration Test Article");
  });

  it("should extract custom attributes like @href and @src in product card", async () => {
    const res = await extractStructured({
      url: `${baseUrl}/product`,
      mode: "fast",
      schema: {
        productTitle: "h1.title",
        price: ".price",
        buyLink: ".cta-button @href",
        image: "img.product-image @src",
      },
      includeMetadata: false,
    });

    expect(res.data?.productTitle).toBe("Wireless Noise-Cancelling Headphones");
    expect(res.data?.price).toBe("$199.99");
    expect(res.data?.buyLink).toBe("/checkout?item=123");
    expect(res.data?.image).toBe("/static/headphones.jpg");
  });

  it("should pass custom HTTP headers and cookies for gated content", async () => {
    const markdown = await extractFast({
      url: `${baseUrl}/gated-content`,
      headers: {
        Authorization: "Bearer secret-crawler-token",
      },
      cookies: {
        session: "valid-session-123",
      },
    });

    expect(markdown).toContain("Confidential Document");
    expect(markdown).toContain("Unlocked secret content for authenticated agents.");
  });

  it("should automatically retry transient 503 errors and succeed", async () => {
    flakyAttempts = 0;
    const markdown = await extractFast({
      url: `${baseUrl}/flaky-endpoint`,
      maxRetries: 3,
    });

    expect(markdown).toContain("Recovered Content");
    expect(flakyAttempts).toBe(2);
  });

  it("should perform batch extraction concurrently while preserving input URL ordering", async () => {
    const urls = [
      `${baseUrl}/page3`,
      `${baseUrl}/page1`,
      `${baseUrl}/page2`,
    ];

    const batch = await batchExtract({
      urls,
      mode: "fast",
      concurrency: 3,
    });

    expect(batch.totalUrls).toBe(3);
    expect(batch.successful).toBe(3);
    expect(batch.failed).toBe(0);
    expect(batch.results.length).toBe(3);

    // Exact order preservation
    expect(batch.results[0].url).toBe(`${baseUrl}/page3`);
    expect(batch.results[0].markdown).toContain("Page 3");

    expect(batch.results[1].url).toBe(`${baseUrl}/page1`);
    expect(batch.results[1].markdown).toContain("Page 1");

    expect(batch.results[2].url).toBe(`${baseUrl}/page2`);
    expect(batch.results[2].markdown).toContain("Page 2");

    expect(batch.totalEstimatedTokens).toBeGreaterThan(0);
  });
});
