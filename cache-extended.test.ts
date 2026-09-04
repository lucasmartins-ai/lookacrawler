import { describe, it, expect, beforeEach } from "bun:test";
import {
  getCachedPage,
  setCachedPage,
  clearCache,
  buildCacheKey,
  pruneExpired,
} from "./cache.js";
import { Database } from "bun:sqlite";

describe("Cache Layer Extended (cache.ts)", () => {
  beforeEach(() => {
    clearCache();
  });

  it("should strip UTM and marketing query params when generating cache key", () => {
    const key1 = buildCacheKey({
      url: "https://example.com/blog/article?utm_source=twitter&utm_medium=social&utm_campaign=launch",
      mode: "fast",
    });
    const key2 = buildCacheKey({
      url: "https://example.com/blog/article",
      mode: "fast",
    });
    const key3 = buildCacheKey({
      url: "https://example.com/blog/article?fbclid=xyz123&gclid=abc456",
      mode: "fast",
    });

    expect(key1).toBe(key2);
    expect(key3).toBe(key2);
  });

  it("should preserve legitimate functional query params in cache key", () => {
    const key1 = buildCacheKey({
      url: "https://example.com/search?q=bun&page=2",
      mode: "fast",
    });
    const key2 = buildCacheKey({
      url: "https://example.com/search?q=bun&page=3",
      mode: "fast",
    });

    expect(key1).not.toBe(key2);
  });

  it("should distinguish different modes and selectors", () => {
    const fastKey = buildCacheKey({ url: "https://example.com", mode: "fast" });
    const deepKey = buildCacheKey({ url: "https://example.com", mode: "deep" });
    const selectorKey = buildCacheKey({
      url: "https://example.com",
      mode: "fast",
      cssSelector: "main",
    });

    expect(fastKey).not.toBe(deepKey);
    expect(fastKey).not.toBe(selectorKey);
  });

  it("should distinguish structured schemas in variant", () => {
    const keyA = buildCacheKey({
      url: "https://example.com",
      mode: "fast",
      variant: { schema: { title: "h1" } },
    });
    const keyB = buildCacheKey({
      url: "https://example.com",
      mode: "fast",
      variant: { schema: { title: "h2" } },
    });

    expect(keyA).not.toBe(keyB);
  });

  it("should expire cache entries after TTL and pruneExpired should remove them", () => {
    const testUrl = "https://example.com/ttl-test";
    // Store with old timestamp older than 24h
    setCachedPage(testUrl, "Content will expire", Date.now() - 25 * 60 * 60 * 1000);

    // getCachedPage should return null on expired items
    expect(getCachedPage(testUrl)).toBeNull();

    // Re-insert expired entry directly
    setCachedPage("https://example.com/expired-item", "Stale data", Date.now() - 25 * 60 * 60 * 1000);
    const removedCount = pruneExpired();
    expect(removedCount).toBeGreaterThanOrEqual(1);
  });

  it("should clear all cached items when clearCache is called", () => {
    setCachedPage("https://a.com", "Content A");
    setCachedPage("https://b.com", "Content B");
    setCachedPage("https://c.com", "Content C");

    expect(getCachedPage("https://a.com")).toBe("Content A");
    expect(getCachedPage("https://b.com")).toBe("Content B");

    clearCache();

    expect(getCachedPage("https://a.com")).toBeNull();
    expect(getCachedPage("https://b.com")).toBeNull();
    expect(getCachedPage("https://c.com")).toBeNull();
  });

  it("should handle rapid concurrent writes without database locked errors", async () => {
    const writes = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => {
        setCachedPage(`https://concurrent.com/page-${i}`, `Payload for page ${i}`);
      })
    );

    await expect(Promise.all(writes)).resolves.toBeDefined();

    for (let i = 0; i < 50; i++) {
      expect(getCachedPage(`https://concurrent.com/page-${i}`)).toBe(`Payload for page ${i}`);
    }
  });
});
