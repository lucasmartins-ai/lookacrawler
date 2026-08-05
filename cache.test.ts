import { describe, expect, test, beforeEach } from "bun:test";
import { getCachedPage, setCachedPage, TTL_MS } from "./cache.js";

describe("SQLite Cache Layer (cache.ts)", () => {
  const testUrl = "https://example.com/test-page";
  const testContent = "# Sample Markdown Content\n\nThis is a cached test page.";

  test("should store and retrieve page content within TTL", () => {
    setCachedPage(testUrl, testContent);
    const cached = getCachedPage(testUrl);
    expect(cached).toBe(testContent);
  });

  test("should return null for uncached URL", () => {
    const cached = getCachedPage("https://example.com/non-existent-page");
    expect(cached).toBeNull();
  });

  test("should overwrite existing cache entry when updated", () => {
    const updatedContent = "# Updated Content";
    setCachedPage(testUrl, updatedContent);
    const cached = getCachedPage(testUrl);
    expect(cached).toBe(updatedContent);
  });
});
