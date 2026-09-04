import { describe, expect, test } from "bun:test";
import { processHtmlToMarkdown } from "./extractor.js";

describe("HTML to Markdown Extraction Pipeline (extractor.ts)", () => {
  const sampleRawHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Test Page Title</title>
      <style>body { background: red; } .hidden { display: none; }</style>
      <script>console.log("unwanted script");</script>
    </head>
    <body>
      <nav><a href="/home">Home</a><a href="/about">About</a></nav>
      <header><h1>Welcome to Test Article</h1></header>
      <main id="main-content">
        <article>
          <h2>Main Headline</h2>
          <p>This is the main body paragraph that contains important textual content for LLM parsing.</p>
          <p>Another informative paragraph with key data points.</p>
        </article>
      </main>
      <aside>
        <svg><path d="M0 0h10v10H0z"/></svg>
        <form action="/subscribe"><input type="email" /><button>Submit</button></form>
      </aside>
      <footer><p>&copy; 2026 Example Corp. All rights reserved.</p></footer>
    </body>
    </html>
  `;

  test("should prune unwanted elements (script, style, nav, footer, form, svg)", () => {
    const markdown = processHtmlToMarkdown(sampleRawHtml, {
      url: "https://example.com/test",
    });

    expect(markdown).not.toContain("background: red");
    expect(markdown).not.toContain("unwanted script");
    expect(markdown).not.toContain("Home");
    expect(markdown).not.toContain("All rights reserved");
    expect(markdown).not.toContain("Submit");
    expect(markdown).toContain("Main Headline");
    expect(markdown).toContain("important textual content");
  });

  test("should narrow extraction when cssSelector is specified", () => {
    const selectorHtml = `
      <html>
        <body>
          <div class="sidebar"><p>Sidebar noise content</p></div>
          <div id="target-div"><p>Specific target article paragraph</p></div>
        </body>
      </html>
    `;

    const markdown = processHtmlToMarkdown(selectorHtml, {
      url: "https://example.com/target",
      cssSelector: "#target-div",
    });

    expect(markdown).toContain("Specific target article paragraph");
    expect(markdown).not.toContain("Sidebar noise content");
  });

  test("should collapse excess whitespace into clean markdown paragraphs", () => {
    const messyHtml = `
      <html>
        <body>
          <h1>Heading</h1>
          <p>Paragraph 1</p>
          <br/><br/><br/>
          <p>Paragraph 2</p>
        </body>
      </html>
    `;

    const markdown = processHtmlToMarkdown(messyHtml, {
      url: "https://example.com/messy",
    });

    expect(markdown).not.toMatch(/\n{3,}/);
    expect(markdown).toContain("Heading");
  });

  test("should convert HTML tables into clean GFM Markdown tables", () => {
    const tableHtml = `
      <html>
        <body>
          <main>
            <h1>Pricing Table</h1>
            <table>
              <thead>
                <tr><th>Plan</th><th>Monthly</th><th>Yearly</th></tr>
              </thead>
              <tbody>
                <tr><td>Free</td><td>$0</td><td>$0</td></tr>
                <tr><td>Pro</td><td>$20</td><td>$200</td></tr>
              </tbody>
            </table>
          </main>
        </body>
      </html>
    `;

    const markdown = processHtmlToMarkdown(tableHtml, {
      url: "https://example.com/pricing",
    });

    expect(markdown).toContain("| Plan | Monthly | Yearly |");
    expect(markdown).toContain("| Free | $0 | $0 |");
    expect(markdown).toContain("| Pro | $20 | $200 |");
  });

  test("should resolve relative URLs to absolute URLs", () => {
    const relativeHtml = `
      <html>
        <body>
          <main>
            <h1>Documentation</h1>
            <p>Visit the <a href="/docs/getting-started">Getting Started</a> guide.</p>
            <p>Check the <a href="../api">API Reference</a>.</p>
          </main>
        </body>
      </html>
    `;

    const markdown = processHtmlToMarkdown(relativeHtml, {
      url: "https://example.com/v1/intro",
    });

    expect(markdown).toContain("[Getting Started](https://example.com/docs/getting-started)");
    expect(markdown).toContain("[API Reference](https://example.com/api)");
  });
});
