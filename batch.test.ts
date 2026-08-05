import { describe, test, expect } from "bun:test";
import { batchExtract } from "./extractor.js";

describe("Batch Extraction (extractor.ts)", () => {
  test("batchExtract should crawl multiple URLs concurrently and compute token statistics", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: any) => {
      const urlStr = String(url);
      const pageTitle = urlStr.includes("page1") ? "Page One" : "Page Two";
      const html = `<html><head><title>${pageTitle}</title></head><body><h1>${pageTitle}</h1><p>Content for ${pageTitle}.</p></body></html>`;
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    };

    try {
      const urls = [
        "https://example.com/page1",
        "https://example.com/page2",
      ];

      const batchResult = await batchExtract({
        urls,
        mode: "fast",
        concurrency: 2,
      });

      expect(batchResult.totalUrls).toBe(2);
      expect(batchResult.successful).toBe(2);
      expect(batchResult.failed).toBe(0);
      expect(batchResult.totalCharCount).toBeGreaterThan(0);
      expect(batchResult.totalEstimatedTokens).toBeGreaterThan(0);

      const r1 = batchResult.results.find((r) => r.url === "https://example.com/page1");
      const r2 = batchResult.results.find((r) => r.url === "https://example.com/page2");

      expect(r1?.success).toBe(true);
      expect(r1?.markdown).toContain("Page One");
      expect(r2?.success).toBe(true);
      expect(r2?.markdown).toContain("Page Two");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("batchExtract should handle individual URL errors gracefully without failing whole batch", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes("error")) {
        return new Response("Forbidden", { status: 403 });
      }
      return new Response("<html><body><h1>Valid Page</h1></body></html>", { status: 200 });
    };

    try {
      const urls = [
        "https://example.com/valid",
        "https://example.com/error",
      ];

      const batchResult = await batchExtract({
        urls,
        mode: "fast",
        concurrency: 2,
      });

      expect(batchResult.totalUrls).toBe(2);
      expect(batchResult.successful).toBe(1);
      expect(batchResult.failed).toBe(1);
      
      const errItem = batchResult.results.find((r) => r.url === "https://example.com/error");
      expect(errItem?.success).toBe(false);
      expect(errItem?.error).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
