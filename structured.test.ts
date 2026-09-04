import { describe, test, expect } from "bun:test";
import { extractMetadata, extractStructured } from "./extractor.js";

describe("Structured & Metadata Extraction (extractor.ts)", () => {
  const sampleHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Sample Article Title</title>
      <meta name="description" content="This is a test article description for metadata testing.">
      <meta property="og:title" content="OG Article Title">
      <meta property="og:description" content="OG Article Description">
      <meta property="og:image" content="https://example.com/image.png">
      <meta property="og:type" content="article">
      <meta property="og:url" content="https://example.com/article">
      <link rel="canonical" href="https://example.com/canonical-article">
      <meta name="author" content="Jane Doe">
      <meta property="article:published_time" content="2026-08-05T10:00:00Z">
      <meta name="keywords" content="crawling, mcp, token economy, bun">
    </head>
    <body>
      <h1 class="main-title">Sample Article Title</h1>
      <p class="byline">By Jane Doe</p>
      <div class="content">
        <p class="paragraph">First paragraph content.</p>
        <p class="paragraph">Second paragraph content.</p>
      </div>
      <ul class="features">
        <li>Feature 1</li>
        <li>Feature 2</li>
      </ul>
    </body>
    </html>
  `;

  test("extractMetadata should correctly parse Open Graph and standard meta tags", () => {
    const metadata = extractMetadata(sampleHtml, "https://example.com/article");

    expect(metadata.title).toBe("Sample Article Title");
    expect(metadata.description).toBe("This is a test article description for metadata testing.");
    expect(metadata.ogTitle).toBe("OG Article Title");
    expect(metadata.ogDescription).toBe("OG Article Description");
    expect(metadata.ogImage).toBe("https://example.com/image.png");
    expect(metadata.ogType).toBe("article");
    expect(metadata.ogUrl).toBe("https://example.com/article");
    expect(metadata.canonicalUrl).toBe("https://example.com/canonical-article");
    expect(metadata.author).toBe("Jane Doe");
    expect(metadata.publishedTime).toBe("2026-08-05T10:00:00Z");
    expect(metadata.keywords).toEqual(["crawling", "mcp", "token economy", "bun"]);
  });

  test("extractStructured should extract schema CSS selector key-value pairs", async () => {
    // Mock fetch for fast structured extract
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      return new Response(sampleHtml, { status: 200, headers: { "content-type": "text/html" } });
    };

    try {
      const result = await extractStructured({
        url: "https://example.com/article",
        mode: "fast",
        schema: {
          headline: ".main-title",
          authorName: ".byline",
          featureList: ".features li",
        },
        includeMetadata: true,
      });

      expect(result.url).toBe("https://example.com/article");
      expect(result.metadata?.title).toBe("Sample Article Title");
      expect(result.metadata?.author).toBe("Jane Doe");
      expect(result.data?.headline).toBe("Sample Article Title");
      expect(result.data?.authorName).toBe("By Jane Doe");
      expect(result.data?.featureList).toEqual(["Feature 1", "Feature 2"]);
      expect(result.markdown).toContain("First paragraph content");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("extractMetadata should parse JSON-LD structured data blocks", () => {
    const jsonLdHtml = `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Product",
              "name": "Mechanical Keyboard",
              "offers": { "@type": "Offer", "price": "149.99", "priceCurrency": "USD" }
            }
          </script>
        </head>
        <body><h1>Product Page</h1></body>
      </html>
    `;

    const metadata = extractMetadata(jsonLdHtml, "https://example.com/product");
    expect(metadata.jsonLd).toBeDefined();
    expect(metadata.jsonLd?.[0]?.name).toBe("Mechanical Keyboard");
    expect(metadata.jsonLd?.[0]?.offers?.price).toBe("149.99");
  });

  test("extractStructured should support attribute extraction (@href, @src)", async () => {
    const htmlWithAttrs = `
      <html>
        <body>
          <a class="cta" href="https://example.com/buy-now">Buy Product</a>
          <img class="hero" src="https://example.com/keyboard.jpg" alt="Keyboard" />
        </body>
      </html>
    `;

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      return new Response(htmlWithAttrs, { status: 200, headers: { "content-type": "text/html" } });
    };

    try {
      const result = await extractStructured({
        url: "https://example.com/product",
        mode: "fast",
        schema: {
          ctaLink: "a.cta @href",
          heroImage: "img.hero @src",
          ctaText: "a.cta",
        },
      });

      expect(result.data?.ctaLink).toBe("https://example.com/buy-now");
      expect(result.data?.heroImage).toBe("https://example.com/keyboard.jpg");
      expect(result.data?.ctaText).toBe("https://example.com/buy-now"); // Auto-extracted href for <a> tag
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
