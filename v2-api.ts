import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PageAction } from "./extractor.js";
import type { CrawlWebsiteOptions, CrawlWebsiteResult, MapWebsiteOptions, MapWebsiteResult } from "./crawler.js";
import { validateTargetUrl } from "./security.js";

/**
 * Firecrawl v2-compatible routes (POST /v2/scrape, POST /v2/map, POST /v2/crawl,
 * GET /v2/crawl/:id) so a Firecrawl SDK pointed at this server works unchanged.
 *
 * Only fields we can honour are accepted. A field whose value asks for
 * behaviour we do not have (screenshots, subdomains, robots.txt, geo proxies…)
 * gets a 400 naming the field, instead of being silently ignored. Fields that
 * change nothing here (SDK attribution, cache hints on a path that never
 * caches) are accepted as no-ops.
 *
 * Auth, Origin and Host checks run in index.ts before this handler; every
 * fetch goes through the extractor, so the SSRF check and egress guard apply.
 */

export interface ScrapeRequest {
  url: string;
  mode: "fast" | "deep";
  headers?: Record<string, string>;
  timeoutMs?: number;
  actions?: PageAction[];
}

export interface V2Deps {
  scrape(req: ScrapeRequest): Promise<string>;
  map(opts: MapWebsiteOptions): Promise<MapWebsiteResult>;
  crawl(opts: CrawlWebsiteOptions): Promise<CrawlWebsiteResult>;
}

const defaultDeps: V2Deps = {
  async scrape({ url, mode, headers, timeoutMs, actions }) {
    const { extractFast, extractDeep } = await import("./extractor.js");
    const base = { url, headers, timeoutMs, linkFormat: "inline" as const };
    return mode === "deep" ? extractDeep({ ...base, actions }) : extractFast(base);
  },
  map: async (opts) => (await import("./crawler.js")).mapWebsite(opts),
  crawl: async (opts) => (await import("./crawler.js")).crawlWebsite(opts),
};

const MAX_BODY_BYTES = 1_000_000;
const MAX_MAP_LIMIT = 5_000;
const MAX_CRAWL_LIMIT = 100;
const MAX_RUNNING_CRAWLS = 2;
const MAX_STORED_CRAWLS = 50;
const CRAWL_TTL_MS = 60 * 60 * 1000;
/**
 * Finished crawls keep their Markdown in memory until they expire, so they share
 * a budget. ponytail: running crawls are bounded only by limit × the per-page
 * response cap; stream results to disk if crawls must be large.
 */
const MAX_STORED_BYTES = 200 * 1024 * 1024;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const bad = (message: string) => new HttpError(400, message);

type Body = Record<string, unknown>;
type Check = (value: unknown) => boolean;

const isBool: Check = (v) => typeof v === "boolean";
const is = (expected: unknown): Check => (v) => v === expected;
const isString: Check = (v) => typeof v === "string";
const isStringRecord: Check = (v) =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
const intIn = (min: number, max: number): Check => (v) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const emptyArray: Check = (v) => Array.isArray(v) && v.length === 0;

/** Accepted in every body; they change nothing about the result. */
const COMMON_NOOPS: Record<string, Check> = {
  origin: isString, // every Firecrawl SDK stamps this
  integration: isString,
  zeroDataRetention: isBool, // v2 scrapes never touch the cache; crawl jobs live in memory only
};

/**
 * Reject any key that is neither honoured nor a no-op with an acceptable value.
 * `honoured` keys are validated by the caller.
 */
function checkFields(body: Body, honoured: Record<string, Check>, noops: Record<string, Check>, where: string): void {
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    const rule = honoured[key] ?? noops[key] ?? COMMON_NOOPS[key];
    if (!rule) throw bad(`${where}: field "${key}" is not supported by lookacrawler`);
    if (!rule(value)) throw bad(`${where}: unsupported value for "${key}": ${JSON.stringify(value).slice(0, 80)}`);
  }
}

const SUPPORTED_FORMATS = new Set(["markdown", "links"]);

function parseFormats(value: unknown, where: string): Set<string> {
  if (value === undefined || value === null) return new Set(["markdown"]);
  if (!Array.isArray(value)) throw bad(`${where}: "formats" must be an array`);
  const out = new Set<string>();
  for (const f of value) {
    const name = typeof f === "string" ? f : f && typeof f === "object" ? (f as Body).type : undefined;
    if (typeof name !== "string" || !SUPPORTED_FORMATS.has(name) || (typeof f === "object" && Object.keys(f).length > 1)) {
      throw bad(`${where}: format ${JSON.stringify(f).slice(0, 60)} is not supported (lookacrawler serves: markdown, links)`);
    }
    out.add(name);
  }
  if (out.size === 0) throw bad(`${where}: "formats" is empty`);
  return out;
}

/** Firecrawl actions we can run in the browser, mapped to ours. */
function parseActions(value: unknown): PageAction[] {
  if (!Array.isArray(value) || value.length > 20) throw bad('scrape: "actions" must be an array of at most 20 items');
  return value.map((a: any) => {
    if (a?.type === "wait" && intIn(0, 10_000)(a.milliseconds) && Object.keys(a).length === 2) {
      return { type: "wait", milliseconds: a.milliseconds };
    }
    if (a?.type === "click" && isString(a.selector) && a.selector.length <= 500 && !a.all) return { type: "click", selector: a.selector };
    if (a?.type === "scroll" && (a.direction === undefined || a.direction === "up" || a.direction === "down") && a.selector === undefined) {
      return { type: "scroll", direction: a.direction ?? "down" };
    }
    throw bad(`scrape: action ${JSON.stringify(a).slice(0, 80)} is not supported (lookacrawler runs: wait, click, scroll)`);
  });
}

const SCRAPE_NOOPS: Record<string, Check> = {
  onlyMainContent: is(true), // our pipeline always strips nav/footer/boilerplate
  onlyCleanContent: is(false),
  maxAge: (v) => typeof v === "number", // v2 never serves from cache, so any max age holds
  storeInCache: isBool,
  removeBase64Images: isBool, // images are dropped from the markdown
  blockAds: is(true),
  mobile: is(false),
  skipTlsVerification: is(false),
  includeTags: emptyArray,
  excludeTags: emptyArray,
  parsers: (v) => Array.isArray(v) && v.every((p) => p === "pdf" || (p as Body)?.type === "pdf"),
  lockdown: is(false),
  checkPromptInjection: is(false),
  redactPII: is(false),
  fastMode: isBool,
  auditMetadata: () => true,
};

interface ScrapePlan {
  formats: Set<string>;
  request: Omit<ScrapeRequest, "url">;
}

/** Validate Firecrawl ScrapeOptions (top level of /scrape, or crawl's scrapeOptions). */
function parseScrapeOptions(body: Body, where: string, allowBrowserSteps: boolean, extraHonoured: Record<string, Check> = {}): ScrapePlan {
  const honoured: Record<string, Check> = {
    ...extraHonoured,
    formats: () => true,
    headers: isStringRecord,
    timeout: intIn(1_000, 300_000),
    proxy: (v) => v === "basic" || v === "auto" || v === "stealth" || v === "enhanced",
    ...(allowBrowserSteps ? { waitFor: intIn(0, 10_000), actions: () => true } : { waitFor: is(0) }),
  };
  checkFields(body, honoured, SCRAPE_NOOPS, where);
  const formats = parseFormats(body.formats, where);
  const actions: PageAction[] = [];
  if (allowBrowserSteps && typeof body.waitFor === "number" && body.waitFor > 0) {
    actions.push({ type: "wait", milliseconds: body.waitFor });
  }
  if (allowBrowserSteps && body.actions != null) actions.push(...parseActions(body.actions));
  if (actions.length > 20) throw bad(`${where}: "waitFor" plus "actions" make more than 20 browser steps`);
  // "auto" is fast mode, which escalates to the browser on an anti-bot block only when LOOKACRAWLER_AUTO_STEALTH=1.
  // Firecrawl's proxy is a tier name, never a proxy URL, so it never reaches our proxy option.
  const browser = body.proxy === "stealth" || body.proxy === "enhanced" || actions.length > 0;
  return {
    formats,
    request: {
      mode: browser ? "deep" : "fast",
      headers: body.headers as Record<string, string> | undefined,
      timeoutMs: body.timeout as number | undefined,
      actions: actions.length ? actions : undefined,
    },
  };
}

async function requireUrl(body: Body, where: string): Promise<string> {
  if (typeof body.url !== "string" || !body.url.trim()) throw bad(`${where}: "url" is required`);
  const url = body.url.trim();
  try {
    await validateTargetUrl(url);
  } catch (err) {
    throw bad(`${where}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return url;
}

function linksOf(markdown: string, pageUrl: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    try {
      const u = new URL(m[1], pageUrl);
      if (u.protocol === "http:" || u.protocol === "https:") out.add(u.toString());
    } catch {
      /* not a URL */
    }
  }
  return [...out];
}

function toDocument(markdown: string, url: string, formats: Set<string>) {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return {
    ...(formats.has("markdown") ? { markdown } : {}),
    ...(formats.has("links") ? { links: linksOf(markdown, url) } : {}),
    metadata: { sourceURL: url, url, statusCode: 200, ...(title ? { title } : {}) },
  };
}

// --- crawl jobs -------------------------------------------------------------

interface CrawlJob {
  status: "scraping" | "completed" | "failed";
  /** Set when the crawl ends; the result expires CRAWL_TTL_MS after that. */
  finishedAt?: number;
  bytes: number;
  result?: CrawlWebsiteResult;
  error?: string;
  formats: Set<string>;
}

// ponytail: in-memory jobs, lost on restart and per process; a job store if crawls must survive restarts.
const jobs = new Map<string, CrawlJob>();

function pruneJobs(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > CRAWL_TTL_MS) jobs.delete(id);
  }
}

/** Test hook. */
const storedBytes = () => [...jobs.values()].reduce((sum, j) => sum + j.bytes, 0);

export function resetCrawlJobs(): void {
  jobs.clear();
}

const CRAWL_NOOPS: Record<string, Check> = {
  sitemap: is("skip"), // we follow links; sitemap-seeded crawling is not implemented
  crawlEntireDomain: is(false),
  allowExternalLinks: is(false),
  allowSubdomains: is(false),
  ignoreQueryParameters: is(false),
  regexOnFullURL: is(false),
  delay: is(0),
};

async function startCrawl(body: Body, deps: V2Deps, baseUrl: string) {
  const url = await requireUrl(body, "crawl");
  checkFields(
    body,
    {
      url: () => true,
      limit: intIn(1, MAX_CRAWL_LIMIT),
      maxDiscoveryDepth: intIn(0, 5),
      includePaths: (v) => Array.isArray(v) && v.every(isString),
      excludePaths: (v) => Array.isArray(v) && v.every(isString),
      maxConcurrency: intIn(1, 10),
      scrapeOptions: (v) => !!v && typeof v === "object" && !Array.isArray(v),
      ignoreRobotsTxt: isBool,
    },
    CRAWL_NOOPS,
    "crawl"
  );
  const plan = parseScrapeOptions((body.scrapeOptions as Body) ?? {}, "crawl.scrapeOptions", false);
  const includePatterns = (body.includePaths as string[] | undefined) ?? [];
  const excludePatterns = (body.excludePaths as string[] | undefined) ?? [];
  // Firecrawl paths are regexes; ours are substrings with * wildcards. Fail now, not inside the job.
  const { compileUrlPatterns } = await import("./crawler.js");
  const regexy = [...includePatterns, ...excludePatterns].find((p) => /[*+?]/.test(p));
  if (regexy) throw bad(`crawl: path "${regexy}" uses a regex quantifier; lookacrawler matches plain path substrings only`);
  try {
    compileUrlPatterns(includePatterns, "include");
    compileUrlPatterns(excludePatterns, "exclude");
  } catch (err) {
    throw bad(`crawl: ${(err as Error).message}`);
  }

  pruneJobs();
  const running = [...jobs.values()].filter((j) => j.status === "scraping").length;
  if (running >= MAX_RUNNING_CRAWLS) throw new HttpError(429, `Too many running crawls (max ${MAX_RUNNING_CRAWLS})`);
  if (storedBytes() >= MAX_STORED_BYTES) throw new HttpError(429, "Stored crawl results are at their memory budget; they expire an hour after finishing");
  if (jobs.size >= MAX_STORED_CRAWLS) throw new HttpError(429, `Too many stored crawls (max ${MAX_STORED_CRAWLS}); they expire after an hour`);

  const id = randomUUID();
  const job: CrawlJob = { status: "scraping", bytes: 0, formats: plan.formats };
  jobs.set(id, job);
  deps
    .crawl({
      startUrl: url,
      maxPages: (body.limit as number | undefined) ?? 10,
      maxDepth: (body.maxDiscoveryDepth as number | undefined) ?? 2,
      concurrency: body.maxConcurrency as number | undefined,
      includePatterns,
      excludePatterns,
      mode: plan.request.mode,
      headers: plan.request.headers,
      timeoutMs: plan.request.timeoutMs,
      linkFormat: "inline",
      ignoreRobots: body.ignoreRobotsTxt === true,
    })
    .then(
      (result) => {
        // ponytail: 2 bytes per UTF-16 code unit, an upper bound on what V8 keeps.
        const bytes = result.pages.reduce((sum, p) => sum + 2 * p.markdown.length, 0);
        const firstError = result.pages.find((p) => p.error)?.error;
        if (!result.pages.some((p) => !p.error)) {
          const vetoed = result.skippedByRobots.includes(url);
          Object.assign(job, { status: "failed", error: firstError || (vetoed ? "robots.txt disallows the start URL" : "No page could be scraped") });
        } else if (storedBytes() + bytes > MAX_STORED_BYTES) {
          Object.assign(job, { status: "failed", error: `Crawl output (${Math.round(bytes / 1e6)} MB) is over the memory budget; lower "limit"` });
        } else {
          Object.assign(job, { status: "completed", result, bytes });
        }
      },
      (err) => Object.assign(job, { status: "failed", error: err instanceof Error ? err.message : String(err) })
    )
    .finally(() => (job.finishedAt = Date.now()));
  return { success: true, id, url: `${baseUrl}/v2/crawl/${id}` };
}

function crawlStatus(id: string) {
  pruneJobs();
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, "Crawl job not found");
  const pages = job.result?.pages ?? [];
  const ok = pages.filter((p) => !p.error);
  return {
    success: true,
    status: job.status,
    total: pages.length,
    completed: ok.length,
    creditsUsed: 0,
    expiresAt: job.finishedAt ? new Date(job.finishedAt + CRAWL_TTL_MS).toISOString() : null,
    next: null,
    data: ok.map((p) => toDocument(p.markdown, p.url, job.formats)),
    ...(job.error ? { error: job.error } : {}),
  };
}

// --- routes -----------------------------------------------------------------

async function readJson(req: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep draining past the cap (without storing): leaving the loop early
  // destroys the request in Bun's node:http and the 413 never reaches the client.
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer);
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw bad("Request body must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw bad("Request body must be a JSON object");
  return parsed as Body;
}

async function scrape(body: Body, deps: V2Deps) {
  const url = await requireUrl(body, "scrape");
  const plan = parseScrapeOptions(body, "scrape", true, { url: () => true });
  const markdown = await withDeadline(deps.scrape({ url, ...plan.request }), plan.request.timeoutMs, "Scrape");
  return { success: true, data: toDocument(markdown, url, plan.formats) };
}

async function map(body: Body, deps: V2Deps) {
  const url = await requireUrl(body, "map");
  checkFields(
    body,
    {
      url: () => true,
      search: isString,
      limit: intIn(1, MAX_MAP_LIMIT),
      ignoreQueryParameters: isBool,
      timeout: intIn(1_000, 300_000),
    },
    {
      sitemap: is("include"), // sitemaps plus the home page's links, which is what we do
      includeSubdomains: is(false), // we map one host
      ignoreCache: isBool, // sitemaps are not cached
      auditMetadata: () => true,
    },
    "map"
  );
  const limit = (body.limit as number | undefined) ?? MAX_MAP_LIMIT;
  const search = typeof body.search === "string" ? body.search.toLowerCase() : "";
  // ponytail: the deadline answers 408 but does not abort discovery still in flight; pass a signal into mapWebsite if that matters.
  // With a search, fetch the full candidate list so the limit applies after ranking.
  const result = await withDeadline(deps.map({ url, maxUrls: search ? MAX_MAP_LIMIT : limit }), body.timeout as number | undefined, "Map");
  let urls = result.urls.map((u) => u.url);
  if (body.ignoreQueryParameters !== false) urls = urls.map((u) => u.split("?")[0]);
  urls = [...new Set(urls)];
  // ponytail: substring relevance, not Firecrawl's ranking; stable sort keeps sitemap order within groups.
  if (search) urls.sort((a, b) => Number(b.toLowerCase().includes(search)) - Number(a.toLowerCase().includes(search)));
  return { success: true, links: urls.slice(0, limit).map((u) => ({ url: u })) };
}

async function withDeadline<T>(work: Promise<T>, ms: number | undefined, what: string): Promise<T> {
  if (!ms) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HttpError(408, `${what} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** Handle one /v2/* request. The caller has already authenticated it. */
export async function handleV2(req: IncomingMessage, res: ServerResponse, pathname: string, deps: V2Deps = defaultDeps): Promise<void> {
  try {
    const crawlId = pathname.match(/^\/v2\/crawl\/([0-9a-f-]{36})$/)?.[1];
    let payload: unknown;
    if (req.method === "POST" && pathname === "/v2/scrape") payload = await scrape(await readJson(req), deps);
    else if (req.method === "POST" && pathname === "/v2/map") payload = await map(await readJson(req), deps);
    else if (req.method === "POST" && pathname === "/v2/crawl") {
      payload = await startCrawl(await readJson(req), deps, `http://${req.headers.host || "localhost"}`);
    } else if (req.method === "GET" && crawlId) payload = crawlStatus(crawlId);
    else throw new HttpError(404, `${req.method} ${pathname} is not served (lookacrawler serves POST /v2/scrape, /v2/map, /v2/crawl and GET /v2/crawl/:id)`);
    send(res, 200, payload);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    send(res, status, { success: false, error: message });
  }
}
