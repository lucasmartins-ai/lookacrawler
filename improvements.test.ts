import { describe, expect, test } from "bun:test";
import { processHtmlToMarkdown } from "./extractor.js";

describe("LookaCrawler Strategic Improvements (extractor.ts)", () => {
  const sampleHtmlWithLinksAndImages = `
    <!DOCTYPE html>
    <html>
      <head><title>Looka Improvements</title></head>
      <body>
        <main>
          <h1>Next-Gen Features</h1>
          <p>Read the <a href="https://example.com/docs">documentation</a> or check our <a href="https://example.com/blog">blog</a>.</p>
          <img src="https://example.com/logo.png" alt="Company Logo" />
          <img src="https://example.com/decorative.jpg" />
        </main>
      </body>
    </html>
  `;

  describe("Token Economy: Link Formatting", () => {
    test("should format links as footnote reference citations (linkFormat: 'references')", () => {
      const markdown = processHtmlToMarkdown(sampleHtmlWithLinksAndImages, {
        url: "https://example.com",
        linkFormat: "references",
      });

      // Should have reference numbers like documentation [1]
      expect(markdown).toContain("documentation [1]");
      expect(markdown).toContain("blog [2]");
      // Footnote bibliography section at the bottom
      expect(markdown).toContain("### Referências");
      expect(markdown).toContain("[1]: https://example.com/docs");
      expect(markdown).toContain("[2]: https://example.com/blog");
      // Should NOT have inline link markdown
      expect(markdown).not.toContain("[documentation](https://example.com/docs)");
    });

    test("should strip links keeping only text when linkFormat is 'strip'", () => {
      const markdown = processHtmlToMarkdown(sampleHtmlWithLinksAndImages, {
        url: "https://example.com",
        linkFormat: "strip",
      });

      expect(markdown).toContain("documentation");
      expect(markdown).toContain("blog");
      expect(markdown).not.toContain("https://example.com/docs");
      expect(markdown).not.toContain("[documentation]");
      expect(markdown).not.toContain("### Referências");
    });

    test("should preserve standard inline links when linkFormat is 'inline'", () => {
      const markdown = processHtmlToMarkdown(sampleHtmlWithLinksAndImages, {
        url: "https://example.com",
        linkFormat: "inline",
      });

      expect(markdown).toContain("[documentation](https://example.com/docs)");
      expect(markdown).toContain("[blog](https://example.com/blog)");
    });
  });

  describe("Token Economy: Semantic Image Modes", () => {
    test("should format images as alt text tokens when imageMode is 'alt_only'", () => {
      const markdown = processHtmlToMarkdown(sampleHtmlWithLinksAndImages, {
        url: "https://example.com",
        imageMode: "alt_only",
      });

      expect(markdown).toContain("[Imagem: Company Logo]");
      expect(markdown).not.toContain("![Company Logo](https://example.com/logo.png)");
      expect(markdown).not.toContain("https://example.com/decorative.jpg");
    });

    test("should completely remove images when imageMode is 'ignore'", () => {
      const markdown = processHtmlToMarkdown(sampleHtmlWithLinksAndImages, {
        url: "https://example.com",
        imageMode: "ignore",
      });

      expect(markdown).not.toContain("Company Logo");
      expect(markdown).not.toContain("https://example.com/logo.png");
      expect(markdown).not.toContain("https://example.com/decorative.jpg");
    });

    test("should produce standard markdown images when imageMode is 'markdown'", () => {
      const markdown = processHtmlToMarkdown(sampleHtmlWithLinksAndImages, {
        url: "https://example.com",
        imageMode: "markdown",
      });

      expect(markdown).toContain("![Company Logo](https://example.com/logo.png)");
    });
  });

  describe("Token Economy: High Link Density Ratio Pruning", () => {
    test("should prune boilerplate blocks with link density > 80%", () => {
      const boilerplateHtml = `
        <!DOCTYPE html>
        <html>
          <body>
            <main>
              <h1>Substantial Article</h1>
              <p>This is a high quality article that contains a large volume of actual content and reading material.</p>
              
              <!-- Tag cloud / link farm boilerplate container -->
              <div class="tag-cloud">
                <a href="/t1">Tag 1</a>
                <a href="/t2">Tag 2</a>
                <a href="/t3">Tag 3</a>
                <a href="/t4">Tag 4</a>
                <a href="/t5">Tag 5</a>
                <a href="/t6">Tag 6</a>
                <a href="/t7">Tag 7</a>
                <a href="/t8">Tag 8</a>
                <a href="/t9">Tag 9</a>
                <a href="/t10">Tag 10</a>
              </div>
            </main>
          </body>
        </html>
      `;

      const markdown = processHtmlToMarkdown(boilerplateHtml, {
        url: "https://example.com",
      });

      expect(markdown).toContain("Substantial Article");
      expect(markdown).toContain("high quality article");
      // The high-link-density div should have been pruned
      expect(markdown).not.toContain("Tag 1");
      expect(markdown).not.toContain("Tag 10");
    });
  });
});
