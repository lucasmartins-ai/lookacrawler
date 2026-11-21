import { describe, expect, test } from "bun:test";
import { extractMetadata, processHtmlToMarkdown } from "./extractor.js";

// Each case is a place where linkedom alone diverged from the jsdom output.
describe("light DOM parse matches jsdom", () => {
  const body = "Enough body text to pass the useful-length floor. ".repeat(6);

  test("a page without <html>/<body> keeps its content", () => {
    const md = processHtmlToMarkdown(`<style>p{}</style><meta name=x content=y><ul><li><a href=/a>First post</a></li></ul><p>${body}</p>`, { url: "https://x.test/" });
    expect(md).toContain("Enough body text");
  });

  test("<title> outside <head> is still the document title", () => {
    expect(extractMetadata(`<html><head><script></script><div></div><title>Real  title</title></head><body><svg><title>Icon</title></svg></body></html>`, "https://x.test/").title).toBe("Real title");
  });

  test("template content stays out of the text", () => {
    const md = processHtmlToMarkdown(`<html><body><article><p>${body}</p><template><p>Hidden template text</p></template></article></body></html>`, { url: "https://x.test/" });
    expect(md).not.toContain("Hidden template text");
  });

  test("hash links resolve against baseURI/documentURI as with jsdom", () => {
    const page = (head: string) => `<html><head>${head}</head><body><article><p>${body} <a href="#s">jump</a> <a href="rel">page</a></p></article></body></html>`;
    const plain = processHtmlToMarkdown(page(""), { url: "https://x.test/start" });
    expect(plain).toContain("[jump](#s)");
    expect(plain).toContain("[page](https://x.test/rel)");
    const based = processHtmlToMarkdown(page(`<base href="/docs/">`), { url: "https://x.test/start" });
    expect(based).toContain("[jump](https://x.test/docs/#s)");
    expect(based).toContain("[page](https://x.test/rel)");
  });

  test("an <article> inside a <noscript> in <head> reaches the body", () => {
    const md = processHtmlToMarkdown(`<html><head><noscript><article><p>${body}</p></article></noscript></head><body></body></html>`, { url: "https://x.test/" });
    expect(md).toContain("Enough body text");
  });

  test("a <base> removed by pruning no longer rewrites hash links", () => {
    const md = processHtmlToMarkdown(`<html><head></head><body><nav><base href="/docs/"></nav><article><p>${body} <a href="#top">top</a></p></article></body></html>`, { url: "https://x.test/start" });
    expect(md).toContain("[top](#top)");
  });

  test("CRLF is normalized like the HTML5 input stream", () => {
    expect(extractMetadata(`<html><head><meta name="description" content="a\r\nb"></head></html>`, "https://x.test/").description).toBe("a\nb");
  });
});
