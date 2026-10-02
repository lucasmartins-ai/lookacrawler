import { describe, expect, test } from "bun:test";
import { searchPlaces, parseCoordinatesFromUrl } from "./places.js";

describe("Places Discovery Module (places.ts)", () => {
  test("should reject empty or blank queries", async () => {
    await expect(searchPlaces({ query: "" })).rejects.toThrow("Search query cannot be empty");
    await expect(searchPlaces({ query: "   " })).rejects.toThrow("Search query cannot be empty");
  });

  test("should correctly parse coordinates from Google Maps URLs", () => {
    const coords1 = parseCoordinatesFromUrl("https://www.google.com/maps/place/Example/@-23.561684,-46.655981,15z/data=...");
    expect(coords1.latitude).toBeCloseTo(-23.561684, 5);
    expect(coords1.longitude).toBeCloseTo(-46.655981, 5);

    const coords2 = parseCoordinatesFromUrl("/maps/place/Shop/@40.712776,-74.005974,17z");
    expect(coords2.latitude).toBeCloseTo(40.712776, 5);
    expect(coords2.longitude).toBeCloseTo(-74.005974, 5);

    const noCoords = parseCoordinatesFromUrl("https://www.google.com/maps/search/pizza");
    expect(noCoords.latitude).toBeUndefined();
    expect(noCoords.longitude).toBeUndefined();
  });

  // Hits google.com/maps for real: slow, rate-limited, and flaky on CI.
  // Opt in with LIVE_PLACES_TEST=1 when you actually want to exercise the browser path.
  test.skipIf(!process.env.LIVE_PLACES_TEST)(
    "should return structured place search result with places array and handle timeouts gracefully",
    async () => {
      const result = await searchPlaces({
        query: "cafeteria centro sao paulo",
        limit: 2,
        timeoutMs: 5000,
      });

      expect(result.query).toBe("cafeteria centro sao paulo");
      expect(Array.isArray(result.places)).toBe(true);
      expect(result.places.length).toBeLessThanOrEqual(2);
    },
    35000
  );
});
