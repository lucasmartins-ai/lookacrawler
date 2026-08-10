import { describe, expect, test } from "bun:test";
import { buildCacheKey } from "./cache.js";

describe("Cache key", () => {
  test("varies with extraction mode and selector", () => {
    const fast = buildCacheKey({ url: "https://example.com", mode: "fast" });
    const deep = buildCacheKey({ url: "https://example.com", mode: "deep" });
    const scoped = buildCacheKey({ url: "https://example.com", mode: "fast", cssSelector: "main" });

    expect(fast).not.toBe(deep);
    expect(fast).not.toBe(scoped);
  });
});
