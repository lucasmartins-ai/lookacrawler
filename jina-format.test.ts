import { describe, test, expect } from "bun:test";
import { formatJinaReader } from "./jina-format";

describe("Jina Reader output", () => {
  test("adds standard metadata headers and preserves Markdown", () => {
    expect(formatJinaReader("https://example.com", "# Example\n\nBody")).toBe(
      "Title: Example\nURL Source: https://example.com\nMarkdown Content:\n# Example\n\nBody",
    );
  });

  test("uses first line as title when Markdown has no heading", () => {
    expect(formatJinaReader("https://example.com", "Body")).toContain("Title: Body\nURL Source:");
  });
});
