import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { extractContacts } from "./contacts.js";
import { deepEnrichLead } from "./enrichment-bridge.js";
import { crawlWebsite, mapWebsite } from "./crawler.js";
import { extractFast, withEscalationHint } from "./extractor.js";
import { classifyFailure } from "./errors.js";
import { isPathAllowed, loadRobots, parseRobots, robotsFromText, robotsPatternMatches } from "./robots.js";

const HOME = `<!DOCTYPE html><html><body>
  <h1>Clínica Trust</h1>
  <p>Ligue (62) 3333-4444.</p>
  <a href="mailto:home@trust.example">home@trust.example</a>
  <a href="/contato">Contato</a>
  <a href="/private/area">Area</a>
  <a href="/public">Public</a>
  <a href="/go-private">Shortcut</a>
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
// A second origin, for cross-origin redirects.
let otherServer: ReturnType<typeof Bun.serve>;
let other: string;
const otherAuth: Array<[string, string | null]> = [];

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
      if (path === "/go-private") return new Response(null, { status: 302, headers: { Location: "/private/area" } });
      if (path === "/moved") return new Response(null, { status: 301, headers: { Location: "/landing" } });
      if (path === "/landing") return html(`<html><body><a href="mailto:landing@trust.example">x</a></body></html>`);
      if (path === "/sitemap.xml") return new Response(`<urlset><url><loc>${base}/public</loc></url></urlset>`, { headers: { "Content-Type": "application/xml" } });
      if (path === "/go-cf") return new Response(null, { status: 302, headers: { Location: "/private/cloudflare-area" } });
      if (path === "/xorigin") return new Response(null, { status: 302, headers: { Location: `${other}/` } });
      if (path === "/blocked") return html("<html><title>Just a moment...</title><body>Checking your browser</body></html>", 403);
      return new Response("Not Found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
  otherServer = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      otherAuth.push([path, req.headers.get("authorization")]);
      return new Response(path === "/" ? HOME : CONTATO, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },
  });
  other = `http://127.0.0.1:${otherServer.port}`;
});

afterAll(() => {
  server.stop(true);
  otherServer.stop(true);
  delete process.env.LOOKACRAWLER_ALLOW_LOCAL;
});

afterEach(() => {
  robotsTxt = null;
  robotsStatus = 200;
  for (const k of Object.keys(hits)) delete hits[k];
  otherAuth.length = 0;
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

describe("provenance after codex review", () => {
  test("a redirected page is named by its final URL", async () => {
    const r = await extractContacts({ url: `${base}/moved`, deepScan: false });
    expect(r.evidence.find((ev) => ev.value === "landing@trust.example")!.source_url).toBe(`${base}/landing`);
  });

  test("caller-supplied html keeps the caller's fetch time", async () => {
    const at = "2026-11-20T10:00:00.000Z";
    const r = await extractContacts({ url: `${base}/`, html: HOME, observedAt: at, deepScan: false });
    expect(r.evidence.length).toBeGreaterThan(0);
    for (const ev of r.evidence) expect(ev.observed_at).toBe(at);
  });

  test("a refused escalation still classifies as anti_bot", () => {
    expect(classifyFailure(withEscalationHint(new Error("HTTP 401: Just a moment")))).toBe("anti_bot");
  });
});

describe("robots.txt parsing", () => {
  test("comments are cut without a regex (U+2028 and many #)", () => {
    const line = "Disallow: /x #" + "#\u2028".repeat(20000);
    const started = performance.now();
    const { rules } = parseRobots(`User-agent: *\n${line}\n`);
    expect(performance.now() - started).toBeLessThan(200);
    expect(isPathAllowed(rules, "/x/1")).toBe(false);
  });

  test("percent-escapes of unreserved characters are compared decoded", () => {
    const r = robotsFromText("https://s.example", "User-agent: *\nDisallow: /private\nDisallow: /caf%C3%A9\nDisallow: /a%2fb\n");
    expect(r.isAllowed("https://s.example/%70rivate")).toBe(false);
    expect(r.isAllowed("https://s.example/café")).toBe(false);
    expect(r.isAllowed("https://s.example/a%2Fb")).toBe(false);
    expect(r.isAllowed("https://s.example/a/b")).toBe(true);
  });

  test("an unknown record between user-agent lines does not split the group", () => {
    const { rules } = parseRobots("User-agent: lookacrawler\nCrawl-delay: 5\nUser-agent: OtherBot\nDisallow: /x\n");
    expect(isPathAllowed(rules, "/x")).toBe(false);
  });

  test("a pattern without a leading / is ignored; a leading * is kept", () => {
    expect(isPathAllowed(parseRobots("User-agent: *\nDisallow: private\n").rules, "/private")).toBe(true);
    expect(isPathAllowed(parseRobots("User-agent: *\nDisallow: *\n").rules, "/anything")).toBe(false);
  });

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
    // Fetched directly and through the /go-private redirect.
    expect(hits["/private/area"]).toBeGreaterThanOrEqual(1);
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

  test("robots.txt: a 502 with a bot-ish title is unreachable; a challenge word in a comment is not a wall", async () => {
    robotsTxt = "<html><title>Access Denied</title></html>";
    robotsStatus = 502;
    expect((await loadRobots(base)).state).toBe("unreachable");
    robotsTxt = "# protected by cf-turnstile\nUser-agent: *\nDisallow: /private\n";
    robotsStatus = 200;
    const r = await loadRobots(base);
    expect(r.state).toBe("applied");
    expect(r.isAllowed(`${base}/private/area`)).toBe(false);
  });

  test("crawl does not follow a redirect into a disallowed path", async () => {
    robotsTxt = "User-agent: *\nDisallow: /private\n";
    const r = await crawlWebsite({ startUrl: `${base}/go-private`, maxDepth: 0 });
    expect(r.pages[0].error).toContain("disallowed by robots.txt");
    expect(hits["/go-private"]).toBe(1);
    expect(hits["/private/area"]).toBeUndefined();
  });

  test("map fetches no disallowed sitemap and reports a vetoed start URL", async () => {
    robotsTxt = "User-agent: *\nDisallow: /\n";
    const r = await mapWebsite({ url: `${base}/` });
    expect(r.urls).toEqual([]);
    expect(r.skippedByRobots).toContain(`${base}/`);
    expect(hits["/sitemap.xml"]).toBeUndefined();
    expect(hits["/"]).toBeUndefined();
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

describe("delta review fixes", () => {
  const saved = process.env.LOOKACRAWLER_AUTO_STEALTH;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOOKACRAWLER_AUTO_STEALTH;
    else process.env.LOOKACRAWLER_AUTO_STEALTH = saved;
  });

  test("a cross-origin root redirect does not send the caller's headers to the new origin's links", async () => {
    const r = await extractContacts({ url: `${base}/xorigin`, headers: { Authorization: "Bearer secret" } });
    // Root values are named by the page they came from...
    expect(r.evidence.find((e) => e.value === "home@trust.example")?.source_url).toBe(`${other}/`);
    // ...but /contato resolves against the requested origin, so only the redirect itself reaches the other host.
    expect(otherAuth.map(([path]) => path)).toEqual(["/"]);
    expect(hits["/contato"]).toBe(1);
  });

  test("a robots veto naming a 'cloudflare' URL is not escalated to the browser", async () => {
    process.env.LOOKACRAWLER_AUTO_STEALTH = "1";
    const robots = robotsFromText(base, "User-agent: *\nDisallow: /private\n");
    await expect(extractFast({ url: `${base}/go-cf`, maxRetries: 1, allowRedirect: robots.isAllowed })).rejects.toThrow(
      /^Redirect to .*cloudflare-area is disallowed by robots\.txt/
    );
    expect(hits["/private/cloudflare-area"]).toBeUndefined();
  });

  test("a guarded request does not share an unguarded in-flight result", async () => {
    const robots = robotsFromText(base, "User-agent: *\nDisallow: /private\n");
    const [guarded, open] = await Promise.allSettled([
      extractFast({ url: `${base}/go-private`, maxRetries: 1, allowRedirect: robots.isAllowed }),
      extractFast({ url: `${base}/go-private`, maxRetries: 1 }),
    ]);
    expect(guarded.status).toBe("rejected");
    expect(open.status).toBe("fulfilled");
  });

  test("map reports a home redirect into a disallowed path as skipped", async () => {
    robotsTxt = "User-agent: *\nDisallow: /private\n";
    const r = await mapWebsite({ url: `${base}/go-private` });
    expect(r.skippedByRobots).toContain(`${base}/private/area`);
    expect(hits["/private/area"]).toBeUndefined();
  });
});
