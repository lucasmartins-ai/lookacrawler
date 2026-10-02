import { describe, expect, test } from "bun:test";
import { crawlWebsite, extractHrefsFromMarkdown } from "./crawler.js";
import { ProxyManager } from "./resilience.js";
import { decodeCloudflareEmail, extractContacts } from "./contacts.js";
import { processHtmlToMarkdown } from "./extractor.js";

describe("Crawl link discovery reuses extracted markdown", () => {
  // The old path called fetchHtml a second time purely to read hrefs, which
  // doubled traffic and — in `deep` mode — returned raw SPA markup with an
  // empty root, so no links were found and the crawl stopped at depth 0.
  // Asserting on the shared helper is what actually pins the fix: `deep` mode
  // drives a real Playwright browser, which ignores a stubbed global fetch.
  test("extractHrefsFromMarkdown sees inline and footnote links", () => {
    const inline = "See [the guide](https://example.com/guide) for more.";
    expect(extractHrefsFromMarkdown(inline)).toEqual(["https://example.com/guide"]);

    const withTitle = 'See [guide](https://example.com/g "The Guide").';
    expect(extractHrefsFromMarkdown(withTitle)).toEqual(["https://example.com/g"]);

    const footnote = "Body text.\n\n---\n### Referências\n[1]: https://example.com/a\n[2]: https://example.com/b";
    expect(extractHrefsFromMarkdown(footnote)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);

    // `link_format: strip` removes URLs by design — caller must refetch.
    expect(extractHrefsFromMarkdown("Just prose, no links at all.")).toEqual([]);
  });
});

describe("Crawl follows rendered links end to end", () => {
  test("fast mode discovers child pages from extracted markdown", async () => {
    const htmlA = `<html><body><main><article><p>Intro paragraph with enough words to survive readability extraction cleanly.</p><a href="/child">Read the guide</a></article></main></body></html>`;
    const htmlB = `<html><body><main><article><p>Child page body text that is long enough to be kept by the readability pass.</p></article></main></body></html>`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = String(input?.url || input);
      const body = url.includes("child") ? htmlB : htmlA;
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    }) as any;
    process.env.LOOKACRAWLER_ALLOW_LOCAL = "true";

    try {
      const result = await crawlWebsite({
        startUrl: "https://crawl.example.com",
        maxDepth: 1,
        maxPages: 5,
        mode: "fast",
      });
      expect(result.pages.map((p) => p.url)).toContain("https://crawl.example.com/child");
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.LOOKACRAWLER_ALLOW_LOCAL;
    }
  }, 30000);
});

describe("Proxy pool rotation", () => {
  test("cycles through the pool instead of pinning one IP", () => {
    const pool = new ProxyManager(["http://a:1", "http://b:2", "http://c:3"]);
    expect(pool.getProxy()).toBe("http://a:1");
    expect(pool.getProxy()).toBe("http://b:2");
    expect(pool.getProxy()).toBe("http://c:3");
    expect(pool.getProxy()).toBe("http://a:1");
  });

  test("an explicit proxy always overrides the pool", () => {
    const pool = new ProxyManager(["http://a:1"]);
    expect(pool.getProxy("http://explicit:9")).toBe("http://explicit:9");
  });

  test("empty pool is a no-op", () => {
    const pool = new ProxyManager([]);
    expect(pool.getProxy()).toBeUndefined();
    expect(pool.size).toBe(0);
  });
});

describe("Cloudflare email deobfuscation", () => {
  test("decodes the XOR-protected address", () => {
    // key 0x7a, then "contato@" and "exemplo.com.br" XORed byte-wise.
    const plain = "contato@exemplo.com.br";
    const key = 0x7a;
    let hex = key.toString(16).padStart(2, "0");
    for (const ch of plain) hex += (ch.charCodeAt(0) ^ key).toString(16).padStart(2, "0");
    expect(decodeCloudflareEmail(hex)).toBe(plain);
  });

  test("rejects malformed input rather than emitting garbage", () => {
    expect(decodeCloudflareEmail("")).toBeNull();
    expect(decodeCloudflareEmail("zz")).toBeNull();
    expect(decodeCloudflareEmail("abc")).toBeNull();
    expect(decodeCloudflareEmail("7a1122")).toBeNull(); // decodes, but no "@"
  });
});

describe("Footer contacts survive enrichment", () => {
  // Reproduces the reported failure: a site whose only email and social links
  // live in <footer>. The markdown pipeline drops <footer> as boilerplate, so
  // enrichment read back `emails: []`. Asserting both halves pins the cause
  // and the fix — contacts must come from the raw html, not the pruned output.
  const FOOTER_ONLY_HTML = `<html><body>
    <nav><a href="/">Home</a></nav>
    <main><article><p>${"Body paragraph with enough words to survive the readability pass. ".repeat(6)}</p></article></main>
    <footer>
      <p>Reach us: hello@footersecret.example</p>
      <a href="https://instagram.com/footersecret">IG</a>
      <a href="tel:+441234567890">Call</a>
    </footer>
  </body></html>`;

  test("the markdown pipeline does drop footer contacts (the reported bug)", async () => {
    const md = await processHtmlToMarkdown(FOOTER_ONLY_HTML, {
      url: "https://footer.example.com",
      linkFormat: "inline",
    });
    expect(md).not.toContain("footersecret.example");
    expect(md).not.toContain("instagram.com");
  });

  test("extractContacts still finds them because it reads raw html", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(FOOTER_ONLY_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as any;
    process.env.LOOKACRAWLER_ALLOW_LOCAL = "true";

    try {
      const found = await extractContacts({ url: "https://footer.example.com", deepScan: false });
      expect(found.emails).toContain("hello@footersecret.example");
      expect(found.socials.instagram).toBe("https://instagram.com/footersecret");
      expect(found.phones.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.LOOKACRAWLER_ALLOW_LOCAL;
    }
  });
});