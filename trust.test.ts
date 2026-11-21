import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { extractContacts } from "./contacts.js";
import { deepEnrichLead } from "./enrichment-bridge.js";
import { crawlWebsite, mapWebsite } from "./crawler.js";
import { extractFast } from "./extractor.js";
import { isPathAllowed, parseRobots, robotsFromText, robotsPatternMatches } from "./robots.js";

const HOME = `<!DOCTYPE html><html><body>
  <h1>Clínica Trust</h1>
  <p>Ligue (62) 3333-4444.</p>
  <a href="mailto:home@trust.example">home@trust.example</a>
  <a href="/contato">Contato</a>
  <a href="/private/area">Area</a>
  <a href="/public">Public</a>
</body></html>`;
const CONTATO = `<!DOCTYPE html><html><body>
  <p>Agenda: agenda@trust.example</p>
  <a href="tel:+556233334444">Fixo</a>
  <p>Outro: (62) 3333-5555</p>
</body></html>`;
const PAGE = (t: string) => `<!DOCTYPE html><html><body><main><article><h1>${t}</h1><p>${"Texto da página. ".repeat(20)}</p></article></main></body></html>`;

let robotsTxt: string | null = null;
let robotsStatus = 200;
const hits: Record<string, number> = {};
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  process.env.LOOKACRAWLER_ALLOW_LOCAL = "true";
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits[path] = (hits[path] || 0) + 1;
      const html = (body: string, status = 200) =>
        new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (path === "/robots.txt") {
        if (robotsTxt === null) return new Response("Not Found", { status: 404 });
        return new Response(robotsTxt, { status: robotsStatus, headers: { "Content-Type": "text/plain" } });
      }
      if (path === "/") return html(HOME);
      if (path === "/contato") return html(CONTATO);
      if (path === "/private/area" || path === "/public") return html(PAGE(path));
      if (path === "/blocked") return html("<html><title>Just a moment...</title><body>Checking your browser</body></html>", 403);
      return new Response("Not Found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  delete process.env.LOOKACRAWLER_ALLOW_LOCAL;
});

afterEach(() => {
  robotsTxt = null;
  robotsStatus = 200;
  for (const k of Object.keys(hits)) delete hits[k];
});

const isIso = (s: string) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;

describe("per-field provenance", () => {
  test("contacts: every email and phone has evidence with the page it came from", async () => {
    const before = Date.now();
    const r = await extractContacts({ url: `${base}/` });
    expect(r.emails).toEqual(["agenda@trust.example", "home@trust.example"]);
    for (const e of r.emails) expect(r.evidence.some((ev) => ev.type === "email" && ev.value === e)).toBe(true);
    for (const p of r.phones) expect(r.evidence.some((ev) => ev.type === "phone" && ev.value === p)).toBe(true);
    expect(r.evidence).toHaveLength(r.emails.length + r.phones.length);

    const agenda = r.evidence.find((ev) => ev.value === "agenda@trust.example")!;
    expect(agenda.source_url).toBe(`${base}/contato`);
    expect(r.evidence.find((ev) => ev.value === "home@trust.example")!.source_url).toBe(`${base}/`);
    // The tel: link on /contato beats the text match on the home page, and the evidence follows it.
    const fixo = r.evidence.find((ev) => ev.e164 === "+556233334444")!;
    expect(fixo.source_url).toBe(`${base}/contato`);
    for (const ev of r.evidence) {
      expect(isIso(ev.observed_at)).toBe(true);
      expect(Date.parse(ev.observed_at)).toBeGreaterThanOrEqual(before - 1);
    }
  });

  test("enrich: emails, additionalPhones and the input phone all carry evidence", async () => {
    const r = await deepEnrichLead(
      { title: "Clínica Trust", web_site: `${base}/`, emails: ["maps@trust.example"], phone: "+55 62 3000-0000", link: "https://maps.google.com/?cid=1" },
      {},
      async () => null
    );
    expect(r.enrichmentSuccess).toBe(true);
    for (const e of r.emails) expect(r.evidence.some((ev) => ev.type === "email" && ev.value === e)).toBe(true);
    for (const p of r.additionalPhones) expect(r.evidence.some((ev) => ev.type === "phone" && ev.value === p)).toBe(true);
    expect(r.evidence.find((ev) => ev.value === "maps@trust.example")!.source_url).toBe("https://maps.google.com/?cid=1");
    expect(r.evidence.find((ev) => ev.value === "+55 62 3000-0000")!.source_url).toBe("https://maps.google.com/?cid=1");
    expect(r.evidence.find((ev) => ev.value === "agenda@trust.example")!.source_url).toBe(`${base}/contato`);
    for (const ev of r.evidence) expect(isIso(ev.observed_at)).toBe(true);
    // Flat arrays keep their old shape for existing callers.
    expect(r.emails.every((e) => typeof e === "string")).toBe(true);
    expect(r.additionalPhones.every((p) => typeof p === "string")).toBe(true);
  });

  test("enrich: input values without a Maps link are labelled 'input', not the website", async () => {
    const r = await deepEnrichLead({ title: "X", web_site: `${base}/`, emails: ["caller@trust.example"] }, { crawlContactPages: false }, async () => null);
    expect(r.evidence.find((ev) => ev.value === "caller@trust.example")!.source_url).toBe("input");
  });
});

describe("robots.txt parsing", () => {
  test("a group for our token replaces the * group", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: LookaCrawler\nDisallow: /admin\n";
    const { rules } = parseRobots(txt);
    expect(isPathAllowed(rules, "/blog")).toBe(true);
    expect(isPathAllowed(rules, "/admin/x")).toBe(false);
    expect(isPathAllowed(parseRobots(txt, "otherbot").rules, "/blog")).toBe(false);
  });

  test("consecutive user-agent lines share one group; sitemaps are collected", () => {
    const { rules, sitemaps } = parseRobots("User-agent: a\nUser-agent: *\nDisallow: /x # comment\nSitemap: https://s.example/sm.xml\n");
    expect(isPathAllowed(rules, "/x/1")).toBe(false);
    expect(sitemaps).toEqual(["https://s.example/sm.xml"]);
  });

  test("longest match wins and Allow wins a tie; empty Disallow allows all", () => {
    const { rules } = parseRobots("User-agent: *\nDisallow: /docs\nAllow: /docs/public\nAllow: /tie\nDisallow: /tie\n");
    expect(isPathAllowed(rules, "/docs/secret")).toBe(false);
    expect(isPathAllowed(rules, "/docs/public/a")).toBe(true);
    expect(isPathAllowed(rules, "/tie")).toBe(true);
    expect(isPathAllowed(parseRobots("User-agent: *\nDisallow:\n").rules, "/anything")).toBe(true);
  });

  test("* and $ wildcards, matched against path + query", () => {
    expect(robotsPatternMatches("/*.pdf$", "/files/a.pdf")).toBe(true);
    expect(robotsPatternMatches("/*.pdf$", "/files/a.pdf?x=1")).toBe(false);
    expect(robotsPatternMatches("/*?session=", "/a?session=1")).toBe(true);
    expect(robotsPatternMatches("/exact$", "/exact")).toBe(true);
    expect(robotsPatternMatches("/exact$", "/exactly")).toBe(false);
    expect(robotsPatternMatches("/a*b*c$", "/a-c-b-c")).toBe(true);
    expect(robotsPatternMatches("/a*bc$", "/abc")).toBe(true);
    expect(robotsPatternMatches("/a*$", "/abc")).toBe(true);
  });

  test("a hostile pattern does not backtrack", () => {
    const started = performance.now();
    robotsPatternMatches("/" + "*a".repeat(2000) + "$", "/" + "a".repeat(5000) + "b");
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("an HTML body (SPA shell) is not read as rules; /robots.txt itself is always allowed", () => {
    expect(robotsFromText("https://s.example", "<!DOCTYPE html><html></html>").state).toBe("none");
    const r = robotsFromText("https://s.example", "User-agent: *\nDisallow: /\n");
    expect(r.isAllowed("https://s.example/robots.txt")).toBe(true);
    expect(r.isAllowed("https://s.example/")).toBe(false);
    expect(r.isAllowed("http://s.example/page")).toBe(false);
  });
});

describe("robots.txt in crawl and map", () => {
  test("crawl skips disallowed links and never fetches them", async () => {
    robotsTxt = "User-agent: *\nDisallow: /private\n";
    const r = await crawlWebsite({ startUrl: `${base}/`, maxDepth: 1, maxPages: 10 });
    expect(r.robots).toBe("applied");
    expect(r.pages.map((p) => new URL(p.url).pathname)).not.toContain("/private/area");
    expect(r.skippedByRobots).toContain(`${base}/private/area`);
    expect(hits["/private/area"]).toBeUndefined();
    expect(hits["/public"]).toBe(1);
  });

  test("ignoreRobots crawls disallowed links", async () => {
    robotsTxt = "User-agent: *\nDisallow: /private\n";
    const r = await crawlWebsite({ startUrl: `${base}/`, maxDepth: 1, maxPages: 10, ignoreRobots: true });
    expect(r.robots).toBe("ignored");
    expect(r.skippedByRobots).toEqual([]);
    expect(hits["/private/area"]).toBe(1);
  });

  test("a disallowed start URL is reported, not fetched", async () => {
    robotsTxt = "User-agent: lookacrawler\nDisallow: /\n";
    const r = await crawlWebsite({ startUrl: `${base}/`, maxDepth: 1 });
    expect(r.totalPagesCrawled).toBe(0);
    expect(r.skippedByRobots).toEqual([`${base}/`]);
    expect(hits["/"]).toBeUndefined();
  });

  test("a missing robots.txt allows everything; a 5xx allows nothing", async () => {
    const open = await crawlWebsite({ startUrl: `${base}/`, maxDepth: 0 });
    expect(open.robots).toBe("none");
    expect(open.totalPagesCrawled).toBe(1);

    robotsTxt = "oops";
    robotsStatus = 500;
    const shut = await crawlWebsite({ startUrl: `${base}/`, maxDepth: 0 });
    expect(shut.robots).toBe("unreachable");
    expect(shut.totalPagesCrawled).toBe(0);
  });

  test("map leaves disallowed URLs out and reads robots.txt once", async () => {
    robotsTxt = "User-agent: *\nDisallow: /private\n";
    const r = await mapWebsite({ url: `${base}/` });
    const urls = r.urls.map((u) => u.url);
    expect(urls).toContain(`${base}/public`);
    expect(urls).not.toContain(`${base}/private/area`);
    expect(r.skippedByRobots).toContain(`${base}/private/area`);
    expect(hits["/robots.txt"]).toBe(1);

    const all = await mapWebsite({ url: `${base}/`, ignoreRobots: true });
    expect(all.urls.map((u) => u.url)).toContain(`${base}/private/area`);
    expect(all.robots).toBe("ignored");
  });
});

describe("fast -> stealth escalation is opt-in", () => {
  const saved = process.env.LOOKACRAWLER_AUTO_STEALTH;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOOKACRAWLER_AUTO_STEALTH;
    else process.env.LOOKACRAWLER_AUTO_STEALTH = saved;
  });

  test("library default: an anti-bot block fails fast with the switch named", async () => {
    delete process.env.LOOKACRAWLER_AUTO_STEALTH;
    await expect(extractFast({ url: `${base}/blocked`, maxRetries: 1 })).rejects.toThrow(/Anti-Bot protection.*LOOKACRAWLER_AUTO_STEALTH=1/);
  });

  test("enrich keeps classifying the block as anti_bot", async () => {
    process.env.LOOKACRAWLER_AUTO_STEALTH = "0";
    const r = await deepEnrichLead({ title: "B", web_site: `${base}/blocked` }, {}, async () => null);
    expect(r.enrichmentSuccess).toBe(false);
    expect(r.status).toBe("anti_bot");
  });

  test("CLI --no-escalate (and an explicit env 0) turn the CLI default off", async () => {
    for (const [extraArgs, env] of [[["--no-escalate"], {}], [[], { LOOKACRAWLER_AUTO_STEALTH: "0" }]] as const) {
      const proc = Bun.spawn(["bun", "cli.ts", "extract", `${base}/blocked`, "--json", "--no-cache", "--max-retries", "1", ...extraArgs], {
        cwd: import.meta.dir,
        env: { ...process.env, LOOKACRAWLER_AUTO_STEALTH: undefined, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const body = JSON.parse(out);
      expect(body.status).toBe("anti_bot");
      expect(body.reason).toContain("not retried in the stealth browser");
    }
  });
});
