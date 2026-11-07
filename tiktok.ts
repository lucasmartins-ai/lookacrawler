/**
 * TikTok public data: recent videos of a profile and Creative Center trends.
 * Clean-room implementation, see docs/specs/tiktok.md.
 *
 * Rules this module keeps on purpose:
 * - No login, no signed endpoints called by us, no signature forging, no CAPTCHA solving.
 * - Plain Playwright Chromium: none of the stealth patches from browser-manager.ts /
 *   stealth.ts, and no fetch->browser escalation from extractFast().
 * - An extraction failure tries the next path; a 403/429/CAPTCHA stops with
 *   status "blocked" and is never retried.
 */

import { chromium } from "playwright";

export interface TikTokVideo {
  id: string;
  url: string;
  author: string;
  description: string;
  createTime: string | null; // ISO 8601
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  durationSec: number | null;
}

export interface TikTokTrend {
  rank: number;
  kind: "hashtag" | "video";
  id: string;
  name: string; // hashtag without '#', or the video caption
  url: string;
  views: number | null;
  posts: number | null; // hashtag: videos published with it; video: null
  author: string | null; // video: creator handle; hashtag: null
  createTime: string | null;
}

export type TikTokSource = "yt-dlp" | "browser" | "creative-center";
export type TikTokResult<T> =
  | { ok: true; source: TikTokSource; items: T[] }
  | { ok: false; status: "blocked" | "error"; reason: string };

export type TrendKind = "hashtag" | "song" | "creator" | "video";

const HANDLE_RE = /^(?!\.)[A-Za-z0-9._]{1,24}(?<!\.)$/; // no leading/trailing dot, like TikTok
const BLOCK_RE = /HTTP Error 4(03|29)|captcha|verify you are (a )?human|IP address is blocked|blocked from accessing/i;

// ---------- pure helpers (unit-tested against recorded fixtures) ----------

export function normalizeHandle(raw: string): string {
  const h = raw.trim().replace(/^https?:\/\/(www\.)?tiktok\.com\//i, "").replace(/^@/, "").split(/[/?#]/)[0];
  if (!HANDLE_RE.test(h)) throw new Error(`Invalid TikTok handle: ${raw}`);
  return h;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const iso = (unixSec: unknown): string | null => {
  const n = num(unixSec);
  return n ? new Date(n * 1000).toISOString() : null;
};

/** yt-dlp stderr -> "blocked" (stop) or "extraction" (try the next path). */
export function classifyYtDlpError(stderr: string): "blocked" | "extraction" {
  // Drop the "ERROR: [extractor] <id>: " prefix so a handle like "captcha" is not read as a challenge.
  const messages = stderr.replace(/^(ERROR|WARNING): (\[[^\]]+\] )?[^:\s]+: /gm, "");
  return BLOCK_RE.test(messages) ? "blocked" : "extraction";
}

/** `yt-dlp --flat-playlist -J` output for a tiktok:user playlist. */
export function parseYtDlpProfile(json: any, handle: string): TikTokVideo[] {
  return (json?.entries || []).filter(Boolean).map((e: any) => ({
    id: String(e.id),
    url: e.url || `https://www.tiktok.com/@${handle}/video/${e.id}`,
    author: e.uploader || handle,
    description: e.description ?? e.title ?? "",
    createTime: iso(e.timestamp),
    views: num(e.view_count),
    likes: num(e.like_count),
    comments: num(e.comment_count),
    shares: num(e.repost_count), // yt-dlp maps TikTok's shareCount to repost_count
    durationSec: num(e.duration) || null,
  }));
}

/** One item struct as the web app ships it (item_list XHR or rehydration JSON). */
export function parseItemStruct(it: any): TikTokVideo {
  const s = { ...(it.statsV2 || {}), ...(it.stats || {}) };
  const author = it.author?.uniqueId || it.author || "";
  return {
    id: String(it.id),
    url: `https://www.tiktok.com/@${author}/video/${it.id}`,
    author: String(author),
    description: it.desc || "",
    createTime: iso(it.createTime),
    views: num(s.playCount),
    likes: num(s.diggCount),
    comments: num(s.commentCount),
    shares: num(s.shareCount),
    durationSec: num(it.video?.duration) || null,
  };
}

/** Items from the page's own item_list response body or its rehydration script. */
export function parseProfilePageData(itemListBodies: string[], rehydration: string): TikTokVideo[] {
  const lists: any[][] = [];
  for (const b of itemListBodies) {
    try { lists.push(JSON.parse(b).itemList || []); } catch { /* empty or non-JSON body */ }
  }
  try { lists.push(JSON.parse(rehydration).__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo?.itemList || []); } catch {}
  const seen = new Set<string>();
  return lists.flat().filter((it) => it?.id && !seen.has(String(it.id)) && seen.add(String(it.id))).map(parseItemStruct);
}

export function parseHashtagList(body: any): TikTokTrend[] {
  return (body?.items || []).map((it: any, i: number) => ({
    rank: num(it.rankIndex) ?? i + 1,
    kind: "hashtag" as const,
    id: String(it.hashtagID),
    name: it.hashtagName,
    url: `https://www.tiktok.com/tag/${encodeURIComponent(it.hashtagName)}`,
    views: num(it.vv),
    posts: num(it.publishCnt),
    author: null,
    createTime: null,
  }));
}

export function parseTopContents(body: any): TikTokTrend[] {
  return (body?.entityInfos || []).map((e: any, i: number) => {
    const handle = e.itemAuthorInfo?.handlerName || null;
    const id = String(e.itemInfo?.itemID);
    return {
      rank: i + 1,
      kind: "video" as const,
      id,
      name: (e.itemInfo?.title || "").trim(),
      url: handle ? `https://www.tiktok.com/@${handle}/video/${id}` : `https://www.tiktok.com/video/${id}`,
      views: num(e.itemMetrics?.videoViews),
      posts: null,
      author: handle,
      createTime: iso(e.itemInfo?.createTime),
    };
  });
}

// ---------- I/O: yt-dlp and a plain browser ----------

export type YtDlpRun = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const runYtDlp: YtDlpRun = async (args) => {
  const bin = process.env.LOOKACRAWLER_YTDLP || "yt-dlp";
  try {
    const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 60_000);
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  } catch (err: any) {
    return { code: 127, stdout: "", stderr: `yt-dlp not runnable: ${err?.message || err}` };
  }
};

export interface PageCapture {
  docStatus: number | null;
  finalUrl: string;
  captcha: boolean;
  bodies: { url: string; status: number; body: string; postData: string | null }[];
  rehydration: string;
}
export type Browse = (url: string, match: RegExp) => Promise<PageCapture>;

/**
 * Open a public page in a fresh, unmodified Chromium and keep the bodies of the
 * responses the page itself requests (read-only). Always closes the browser.
 */
const browse: Browse = async (url, match) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ locale: "en-US" })).newPage();
    const bodies: PageCapture["bodies"] = [];
    const pending: Promise<void>[] = [];
    page.on("response", (r) => {
      if (!match.test(r.url())) return;
      const entry = { url: r.url(), status: r.status(), body: "", postData: r.request().postData() };
      bodies.push(entry);
      pending.push(r.text().then((body) => { entry.body = body; }, () => {}));
    });
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (resp && resp.status() < 400) {
      await page.waitForResponse((r) => match.test(r.url()), { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1_500); // let sibling requests and a CAPTCHA overlay settle
    }
    // A body that never finishes must not keep the browser open.
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 10_000))]);
    const { captcha, rehydration } = await page.evaluate(() => ({
      captcha: !!document.querySelector("#captcha-verify-container-main-page, .captcha-verify-container, #tiktok-verify-ele, .secsdk-captcha-drag-icon"),
      rehydration: document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent || "",
    }));
    return { docStatus: resp?.status() ?? null, finalUrl: page.url(), captcha, bodies, rehydration };
  } finally {
    await browser.close();
  }
};

/** 403/429 document or a visible CAPTCHA -> blocked; anything else is not. */
export function blockedReason(c: PageCapture): string | null {
  if (c.docStatus === 403 || c.docStatus === 429) return `HTTP ${c.docStatus} on ${c.finalUrl}`;
  const api = c.bodies.find((b) => b.status === 403 || b.status === 429);
  if (api) return `HTTP ${api.status} on ${api.url.split("?")[0]}`;
  if (c.captcha) return `CAPTCHA challenge shown on ${c.finalUrl}`;
  return null;
}

// ---------- commands ----------

export async function tiktokProfile(
  rawHandle: string,
  opts: { limit?: number; ytdlp?: YtDlpRun; browse?: Browse } = {},
): Promise<TikTokResult<TikTokVideo>> {
  let handle: string;
  try { handle = normalizeHandle(rawHandle); } catch (err: any) { return { ok: false, status: "error", reason: err.message }; }
  const limit = Math.min(Math.max(1, opts.limit || 20), 100);
  const profileUrl = `https://www.tiktok.com/@${handle}`;

  const y = await (opts.ytdlp || runYtDlp)(["--ignore-config", "--flat-playlist", "-J", "--playlist-end", String(limit), profileUrl]);
  let ytReason: string;
  if (y.code === 0) {
    try {
      const items = parseYtDlpProfile(JSON.parse(y.stdout), handle);
      if (items.length) return { ok: true, source: "yt-dlp", items: items.slice(0, limit) };
      ytReason = "yt-dlp returned no videos";
    } catch {
      ytReason = "yt-dlp printed invalid JSON";
    }
  } else {
    const err = y.stderr.split("\n").filter((l) => l.startsWith("ERROR")).join(" ") || y.stderr.trim().slice(-300);
    if (classifyYtDlpError(y.stderr) === "blocked") return { ok: false, status: "blocked", reason: `yt-dlp: ${err}` };
    ytReason = `yt-dlp: ${err}`;
  }

  let page: PageCapture;
  try {
    page = await (opts.browse || browse)(profileUrl, /\/api\/post\/item_list\//);
  } catch (err: any) {
    return { ok: false, status: "error", reason: `${ytReason}; browser: ${err?.message || err}` };
  }
  const items = parseProfilePageData(page.bodies.map((b) => b.body), page.rehydration);
  if (items.length) return { ok: true, source: "browser", items: items.slice(0, limit) };
  const blocked = blockedReason(page);
  if (blocked) return { ok: false, status: "blocked", reason: `${ytReason}; browser: ${blocked}` };
  return { ok: false, status: "error", reason: `${ytReason}; browser: no videos in the page data` };
}

const TREND_API: Record<string, RegExp> = {
  hashtag: /\/CreativeOne\/KnowledgeAPI\/GetHashtagList/,
  video: /\/CreativeOne\/Report\/CreativeCenterGetTopContentsList/,
};

export async function tiktokTrends(
  opts: { region?: string; period?: number; kind?: TrendKind; browse?: Browse } = {},
): Promise<TikTokResult<TikTokTrend>> {
  const region = (opts.region || "BR").toUpperCase();
  const period = opts.period ?? 7;
  const kind = opts.kind || "hashtag";
  if (!/^[A-Z]{2}$/.test(region)) return { ok: false, status: "error", reason: `Invalid region: ${opts.region}` };
  if (period !== 7 && period !== 30) return { ok: false, status: "error", reason: "period must be 7 or 30" };
  if (!TREND_API[kind]) {
    // Measured 2026-11-07: /trends/song redirects to the hashtag tab, creator shows "Coming soon".
    return { ok: false, status: "error", reason: `Creative Center does not publish '${kind}' trends without login (only hashtag, video)` };
  }

  const url = `https://ads.tiktok.com/creative/creativeCenter/trends/${kind}?region=${region}&period=${period}`;
  let page: PageCapture;
  try {
    // Measured 2026-11-07: headless Chromium gets HTTP 403 here (plain curl gets 200);
    // we report that as blocked instead of disguising the browser.
    page = await (opts.browse || browse)(url, TREND_API[kind]);
  } catch (err: any) {
    return { ok: false, status: "error", reason: `browser: ${err?.message || err}` };
  }
  const blocked = blockedReason(page);
  if (blocked) return { ok: false, status: "blocked", reason: blocked };

  const served = new URL(page.finalUrl).searchParams.get("region")?.toUpperCase();
  if (served && served !== region) {
    return { ok: false, status: "error", reason: `Creative Center serves '${kind}' trends for ${served}, not ${region}` };
  }
  for (const b of page.bodies) {
    let body: any;
    try { body = JSON.parse(b.body); } catch { continue; }
    const items = kind === "hashtag" ? parseHashtagList(body) : parseTopContents(body);
    if (items.length) return { ok: true, source: "creative-center", items };
  }
  return { ok: false, status: "error", reason: `no ${kind} list in the Creative Center responses` };
}
