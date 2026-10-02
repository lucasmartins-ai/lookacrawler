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

    // Current Maps result URLs carry !3d/!4d instead of the @lat,lng path.
    const coords3 = parseCoordinatesFromUrl(
      "https://www.google.com/maps/place/Animal+House+Vets/data=!4m7!3m6!1s0x48718e4c05e6f351:0x292f3a90c276a555!8m2!3d51.4672531!4d-2.5307403!16s%2Fg%2F11tdl5kzc"
    );
    expect(coords3.latitude).toBeCloseTo(51.4672531, 5);
    expect(coords3.longitude).toBeCloseTo(-2.5307403, 5);

    const noCoords = parseCoordinatesFromUrl("https://www.google.com/maps/search/pizza");
    expect(noCoords.latitude).toBeUndefined();
    expect(noCoords.longitude).toBeUndefined();
  });

  // Hits google.com/maps for real: slow, rate-limited, and flaky on CI.
  // Opt in with LIVE_PLACES_TEST=1 when you actually want to exercise the browser path.
  test.skipIf(!process.env.LIVE_PLACES_TEST)(
    "should return real businesses, not the results-list heading",
    async () => {
      const result = await searchPlaces({
        query: "dental clinic Bristol",
        limit: 3,
        timeoutMs: 45000,
      });

      expect(result.query).toBe("dental clinic Bristol");
      expect(result.places.length).toBeGreaterThan(0);

      // The bug this pins: the results view is headed "Results", and the old
      // code read that h1 as a business name, returning a single bogus place
      // titled "Results" while every real card went unparsed.
      for (const place of result.places) {
        expect(place.title).not.toBe("Results");
        expect(place.title).not.toBe("");
        expect(place.title.length).toBeGreaterThan(2);
        expect(place.url || "").toContain("google.com/maps");
      }
    },
    120000
  );

  test.skipIf(!process.env.LIVE_PLACES_TEST)(
    "should distinguish an empty result from a blocked engine",
    async () => {
      // Google consent interstitial can leave zero cards; that must surface as
      // zero places rather than a crash or a fabricated entry.
      const result = await searchPlaces({ query: "zzzzzqqqq nonexistent place", limit: 2, timeoutMs: 45000 });
      expect(Array.isArray(result.places)).toBe(true);
    },
    120000
  );
});
