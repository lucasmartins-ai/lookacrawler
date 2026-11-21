import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { handleV2, resetCrawlJobs, type ScrapeRequest, type V2Deps } from "./v2-api.js";

const scrapeCalls: ScrapeRequest[] = [];
let crawlGate: Promise<void> = Promise.resolve();
const crawlCalls: any[] = [];

const deps: V2Deps = {
  async scrape(req) {
    scrapeCalls.push(req);
    return "# Acme Dental\n\nCall us. [Book](/book) [Ext](https://other.example/x)";
  },
  async map() {
    return {
      host: "acme.example",
      sitemapsFound: [],
      totalDiscovered: 3,
      urls: [
        { url: "https://acme.example/", source: "sitemap" },
        { url: "https://acme.example/?utm=x", source: "sitemap" },
        { url: "https://acme.example/blog/a", source: "sitemap" },
      ],
    };
  },
  async crawl(opts) {
    crawlCalls.push(opts);
    await crawlGate;
    return {
      startUrl: opts.startUrl!,
      totalPagesCrawled: 2,
      totalEstimatedTokens: 10,
      pages: [
        { url: "https://acme.example/", depth: 0, markdown: "# Home", charCount: 6, estimatedTokens: 2 },
        { url: "https://acme.example/x", depth: 1, markdown: "", charCount: 0, estimatedTokens: 0, error: "boom" },
      ],
    };
  },
};

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleV2(req, res, new URL(req.url || "", "http://x").pathname, deps);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  scrapeCalls.length = 0;
  crawlCalls.length = 0;
  resetCrawlJobs();
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /v2/scrape", () => {
  it("returns a Firecrawl document for string and object formats, SDK origin accepted", async () => {
    const res = await post("/v2/scrape", { url: "https://acme.example/", formats: ["markdown", { type: "links" }], origin: "js-sdk@4.0.0" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.markdown).toContain("Acme Dental");
    expect(body.data.links).toEqual(["https://acme.example/book", "https://other.example/x"]);
    expect(body.data.metadata).toMatchObject({ sourceURL: "https://acme.example/", statusCode: 200, title: "Acme Dental" });
    expect(scrapeCalls[0]).toMatchObject({ url: "https://acme.example/", mode: "fast" });
  });

  it("maps stealth proxy and actions to the browser, never to a proxy URL", async () => {
    await post("/v2/scrape", { url: "https://acme.example/", proxy: "stealth", waitFor: 500, actions: [{ type: "click", selector: "#ok" }] });
    expect(scrapeCalls[0].mode).toBe("deep");
    expect(scrapeCalls[0].actions).toEqual([{ type: "wait", milliseconds: 500 }, { type: "click", selector: "#ok" }]);
    expect(JSON.stringify(scrapeCalls[0])).not.toContain("stealth");
  });

  it("rejects what it cannot honour with a 400 naming the field", async () => {
    for (const [body, needle] of [
      [{ url: "https://acme.example/", formats: ["screenshot"] }, "screenshot"],
      [{ url: "https://acme.example/", location: { country: "BR" } }, "location"],
      [{ url: "https://acme.example/", onlyMainContent: false }, "onlyMainContent"],
      [{ url: "https://acme.example/", actions: [{ type: "executeJavascript", script: "1" }] }, "executeJavascript"],
      [{ formats: ["markdown"] }, "url"],
    ] as const) {
      const res = await post("/v2/scrape", body);
      expect(res.status).toBe(400);
      const out = await res.json();
      expect(out.success).toBe(false);
      expect(out.error).toContain(needle);
    }
    expect(scrapeCalls).toHaveLength(0);
  });

  it("refuses private targets before fetching", async () => {
    const res = await post("/v2/scrape", { url: "http://intranet.private-test/" });
    expect(res.status).toBe(400);
    expect(scrapeCalls).toHaveLength(0);
  });

  it("rejects bad JSON and oversized bodies", async () => {
    const res = await fetch(base + "/v2/scrape", { method: "POST", body: "{nope" });
    expect(res.status).toBe(400);
    const big = await post("/v2/scrape", { url: "https://acme.example/", pad: "x".repeat(1_100_000) });
    expect(big.status).toBe(413);
  });
});

describe("POST /v2/map", () => {
  it("returns links, drops query URLs by default and ranks search hits first", async () => {
    const res = await post("/v2/map", { url: "https://acme.example/", search: "blog" });
    const body = await res.json();
    expect(body).toEqual({ success: true, links: [{ url: "https://acme.example/blog/a" }, { url: "https://acme.example/" }] });
  });

  it("refuses subdomains and sitemap-only", async () => {
    expect((await post("/v2/map", { url: "https://acme.example/", includeSubdomains: true })).status).toBe(400);
    expect((await post("/v2/map", { url: "https://acme.example/", sitemap: "only" })).status).toBe(400);
  });
});

describe("/v2/crawl", () => {
  it("starts a job and reports Firecrawl status until completed", async () => {
    let release!: () => void;
    crawlGate = new Promise((r) => (release = r));
    const start = await post("/v2/crawl", { url: "https://acme.example/", limit: 5, includePaths: ["/docs/*"], scrapeOptions: { formats: ["markdown"] } });
    expect(start.status).toBe(200);
    const { success, id, url } = await start.json();
    expect(success).toBe(true);
    expect(url).toBe(`${base}/v2/crawl/${id}`);
    expect(crawlCalls[0]).toMatchObject({ startUrl: "https://acme.example/", maxPages: 5, includePatterns: ["/docs/*"] });

    const running = await (await fetch(url)).json();
    expect(running.status).toBe("scraping");

    release();
    await Bun.sleep(10);
    const done = await (await fetch(url)).json();
    expect(done).toMatchObject({ success: true, status: "completed", total: 2, completed: 1, next: null });
    expect(done.data).toEqual([{ markdown: "# Home", metadata: { sourceURL: "https://acme.example/", url: "https://acme.example/", statusCode: 200, title: "Home" } }]);
  });

  it("turns Firecrawl regex paths and unsupported options into a 400", async () => {
    expect((await post("/v2/crawl", { url: "https://acme.example/", includePaths: ["^/blog/.*$"] })).status).toBe(400);
    expect((await post("/v2/crawl", { url: "https://acme.example/", limit: 10_000 })).status).toBe(400);
    expect((await post("/v2/crawl", { url: "https://acme.example/", ignoreRobotsTxt: false })).status).toBe(400);
    expect((await post("/v2/crawl", { url: "https://acme.example/", scrapeOptions: { actions: [] } })).status).toBe(400);
    expect(crawlCalls).toHaveLength(0);
  });

  it("caps running crawls and 404s unknown jobs", async () => {
    crawlGate = new Promise(() => {});
    expect((await post("/v2/crawl", { url: "https://acme.example/" })).status).toBe(200);
    expect((await post("/v2/crawl", { url: "https://acme.example/" })).status).toBe(200);
    expect((await post("/v2/crawl", { url: "https://acme.example/" })).status).toBe(429);
    const missing = await fetch(`${base}/v2/crawl/00000000-0000-0000-0000-000000000000`);
    expect(missing.status).toBe(404);
  });
});

describe("index.ts wiring", () => {
  it("puts /v2 behind the SSE bearer token", async () => {
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    const proc = Bun.spawn(["bun", "index.ts", "--transport", "sse", "--port", String(port), "--host", "127.0.0.1"], {
      cwd: import.meta.dir,
      env: { ...process.env, LOOKACRAWLER_SSE_TOKEN: "t0ken" },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const url = `http://127.0.0.1:${port}/v2/scrape`;
      let res: Response | undefined;
      for (let i = 0; i < 70 && !res; i++) {
        res = await fetch(url, { method: "POST", body: "{}" }).catch(() => undefined);
        if (!res) await Bun.sleep(200);
      }
      expect(res?.status).toBe(401);
      const authed = await fetch(url, { method: "POST", headers: { authorization: "Bearer t0ken" }, body: "{nope" });
      expect(authed.status).toBe(400);
      expect((await authed.json()).success).toBe(false);
    } finally {
      proc.kill();
    }
  });
});
