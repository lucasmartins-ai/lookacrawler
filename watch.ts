/**
 * `watch`: one read-only view of a social profile and its recent posts, the
 * same shape for TikTok, Instagram, Threads, Facebook and X.
 *
 * - TikTok goes through tiktok.ts (public: yt-dlp, then a plain browser).
 * - Instagram, Threads, Facebook and X are read from the rendered page in the
 *   user's logged-in Chrome through the bridge (social.ts), never a fresh
 *   browser. Nothing is clicked, typed or posted.
 * - A field the page does not show stays null; numbers are never guessed.
 *
 * ponytail: no bridge lock here. Inside LOOKAORCHESTRATOR, wrap the call with
 * `bridge_lock_wait 900 <platform>` and BRIDGE_SESSION (bridge rules §6).
 */

import { parseShorthandNumber } from "./social-public.js";
import { evalOn, fbPosts, navigate, bridgeStatus, type BridgeSite } from "./social.js";

export type WatchPlatform = "tiktok" | "instagram" | "threads" | "facebook" | "x";
export const WATCH_PLATFORMS: WatchPlatform[] = ["tiktok", "instagram", "threads", "facebook", "x"];

export interface WatchProfile {
  name: string | null;
  bio: string | null;
  followers: number | null;
  following: number | null;
  posts: number | null;
}

export interface WatchPost {
  url: string;
  author: string | null;
  text: string;
  publishedAt: string | null; // ISO 8601 when the page gives a machine date
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null; // reposts + shares where the platform shows them
}

export type WatchStatus = "invalid_input" | "bridge_offline" | "not_logged_in" | "blocked" | "error";

export type WatchResult =
  | {
      ok: true;
      platform: WatchPlatform;
      handle: string;
      url: string;
      source: "bridge" | "yt-dlp" | "browser";
      observedAt: string;
      profile: WatchProfile;
      posts: WatchPost[];
    }
  | { ok: false; platform: WatchPlatform | null; handle: string | null; status: WatchStatus; reason: string };

// ---------- target parsing ----------

const HOSTS: Array<[RegExp, WatchPlatform]> = [
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)threads\.(com|net)$/, "threads"],
  [/(^|\.)facebook\.com$/, "facebook"],
  [/(^|\.)(x|twitter)\.com$/, "x"],
];

const HANDLE_RE = /^[A-Za-z0-9._-]{1,64}$/;
// First path segments that are app routes, not profiles.
const NOT_PROFILES = new Set(["p", "reel", "reels", "explore", "stories", "search", "home", "i", "hashtag", "groups", "watch", "settings", "messages", "post", "status", "intent", "share"]);

/** URL or `@handle` (with `platform`) → canonical profile URL. Throws on anything else. */
export function parseWatchTarget(input: string, platform?: string): { platform: WatchPlatform; handle: string; url: string } {
  const raw = input.trim();
  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const match = HOSTS.find(([re]) => re.test(host));
    if (!match) throw new Error(`not a supported social URL: ${raw}`);
    const p = match[1];
    const first = u.pathname.split("/").filter(Boolean)[0] || "";
    // Facebook groups and pages keep their own path; fbPosts reads any feed URL.
    if (p === "facebook") {
      // profile.php is identified by its ?id=; other app routes (messages, watch...) are not feeds.
      if (first === "profile.php" && /^\d+$/.test(u.searchParams.get("id") || "")) {
        const handle = `profile.php?id=${u.searchParams.get("id")}`;
        return { platform: p, handle, url: `https://www.facebook.com/${handle}` };
      }
      const segs = u.pathname.split("/").filter(Boolean);
      const feed = first === "groups" ? segs.length === 2 : segs.length === 1 && !NOT_PROFILES.has(first.toLowerCase()) && first !== "profile.php";
      if (!feed) throw new Error(`not a profile URL: ${raw}`);
      return { platform: p, handle: u.pathname.replace(/\/+$/, ""), url: `https://www.facebook.com${u.pathname}` };
    }
    const handle = first.replace(/^@/, "");
    const route = !first.startsWith("@") && NOT_PROFILES.has(handle.toLowerCase());
    if (!handle || route || !HANDLE_RE.test(handle)) throw new Error(`not a profile URL: ${raw}`);
    return { platform: p, handle, url: profileUrl(p, handle) };
  }
  const p = (platform || "").toLowerCase() as WatchPlatform;
  if (!WATCH_PLATFORMS.includes(p)) throw new Error(`pass a profile URL, or a handle with --platform ${WATCH_PLATFORMS.join("|")}`);
  const handle = raw.replace(/^@/, "");
  if (!HANDLE_RE.test(handle) || NOT_PROFILES.has(handle.toLowerCase())) throw new Error(`invalid handle: ${input}`);
  return { platform: p, handle, url: profileUrl(p, handle) };
}

function profileUrl(p: WatchPlatform, h: string): string {
  switch (p) {
    case "tiktok": return `https://www.tiktok.com/@${h}`;
    case "instagram": return `https://www.instagram.com/${h}/`;
    case "threads": return `https://www.threads.com/@${h}`;
    case "facebook": return `https://www.facebook.com/${h}`;
    case "x": return `https://x.com/${h}`;
  }
}

// ---------- pure parsers (tested on recorded page text) ----------

// A number, optionally grouped by (narrow) no-break spaces, with a whole-word scale suffix ("1.2 million", "83,1 mil").
const NUM = String.raw`(\d[\d.,]*(?:[\u00a0\u202f]\d{3})*\s*(?:milh(?:ão|ões)|million|bilh(?:ão|ões)|billion|mil|mi|bi|k|m|b)?)(?![a-zà-ú])`;

function toNumber(s: string): number | null {
  const t = s.replace(/(\d)[\u00a0\u202f](?=\d)/g, "$1").replace(/million/i, "m").replace(/billion/i, "b");
  return parseShorthandNumber(t) ?? null;
}

/** First number before one of the labels, e.g. "83,1 mil seguidores" → 83100. */
export function countBefore(text: string, labels: string[]): number | null {
  const re = new RegExp(`${NUM}\\s+(?:${labels.join("|")})\\b`, "i");
  const m = text.match(re);
  return m ? toNumber(m[1]) : null;
}

/** Leading number of an aria-label such as "1,234 Likes. Like" or "12 mil visualizações". */
export function leadingNumber(label: string | null | undefined): number | null {
  const m = (label || "").trim().match(new RegExp(`^${NUM}`, "i"));
  return m ? toNumber(m[1]) : null;
}

const FOLLOWERS = ["followers", "seguidores"];
const FOLLOWING = ["following", "seguindo"];
const POSTS = ["posts", "publicações", "publicacoes", "threads"];

export function profileFromHeader(header: string, name: string | null, bio: string | null): WatchProfile {
  return {
    name: name?.trim() || null,
    bio: bio?.trim() || null,
    followers: countBefore(header, FOLLOWERS),
    following: countBefore(header, FOLLOWING),
    posts: countBefore(header, POSTS),
  };
}

const COUNT_LINE = new RegExp(`^${NUM}\\s+(?:${[...FOLLOWERS, ...FOLLOWING, ...POSTS].join("|")})$`, "i");
const IG_BIO_END = /^(mais|more|seguir|follow|enviar mensagem|message)$|^(seguido\(a\) por|followed by) |^[\w.-]+\.[a-z]{2,}(\/|$)/i;

/** Instagram header text: handle, display name, counts, then the bio up to "mais"/link/"Seguido por". */
export function igNameBio(header: string): { name: string | null; bio: string | null } {
  const lines = header.split("\n").map((l) => l.trim()).filter(Boolean);
  const name = lines[1] && !COUNT_LINE.test(lines[1]) ? lines[1] : null;
  const after = lines.findIndex((l) => /\b(seguindo|following)$/i.test(l));
  const bio: string[] = [];
  for (const l of after < 0 ? [] : lines.slice(after + 1)) {
    if (IG_BIO_END.test(l)) break;
    bio.push(l);
  }
  return { name, bio: bio.join("\n") || null };
}

/** Threads og:description: "5,8 mi seguidores • 175 threads • <bio>. Veja as conversas mais recentes com @x." */
export function threadsBio(og: string | null): string | null {
  const parts = (og || "").split(" • ").filter((p) => !COUNT_LINE.test(p.trim()));
  const bio = parts.join(" • ").replace(/\s*(?:Veja as conversas mais recentes com|See the latest conversations with) @\S+$/i, "").trim();
  return bio || null;
}

/** Drop the translate button and the "1 / 2" carousel counter that sit inside the post text span. */
/** TikTok grid alt text: "<caption> criado por <name> com a música <sound>" (or "created by ... with"). */
export function tiktokCaption(alt: string): string {
  const m = alt.match(/^([\s\S]*?)\s+(?:criado por \S[\s\S]* com a música|created by \S[\s\S]* with) [\s\S]*$/);
  return (m ? m[1] : alt).trim();
}

export function cleanPostText(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^(traduzir|translate|ver tradução|see translation)$/i.test(l.trim()))
    .join("\n")
    .replace(/\s*\n\d+\n\/\n\d+\s*$/, "")
    .trim();
}

// Threads action buttons are labelled by their svg: Curtir/Like, Responder/Reply, Repostar/Repost, Compartilhar/Share.
export function threadsMetrics(actions: Array<{ label: string; text: string }>): Pick<WatchPost, "likes" | "comments" | "shares"> {
  const pick = (re: RegExp) => {
    const a = actions.find((x) => re.test(x.label));
    return a ? leadingNumber(a.text) : null;
  };
  const reposts = pick(/^(repost|repostar)/i);
  const shares = pick(/^(share|compartilhar)/i);
  return {
    likes: pick(/^(like|curtir)/i),
    comments: pick(/^(reply|responder|comment|comentar)/i),
    shares: reposts === null && shares === null ? null : (reposts ?? 0) + (shares ?? 0),
  };
}

// ---------- page scripts (self-contained strings for CDP_EVAL) ----------

// Collect what is on screen now; the caller scrolls and calls again, merging by URL,
// because the bridge gives one eval about 8 s.
const IG_SCRIPT = `(() => {
  const h = document.querySelector("header");
  const posts = [...document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]')].map((a) => {
    const u = new URL(a.getAttribute("href"), location.href);
    return { url: u.origin + u.pathname, text: (a.querySelector("img") || {}).alt || "" };
  });
  return {
    logged: /(^|; )ds_user_id=/.test(document.cookie),
    header: h ? h.innerText : "",
    name: null,
    bio: null,
    posts,
  };
})()`;

const THREADS_SCRIPT = `(() => {
  const posts = [];
  for (const el of document.querySelectorAll('div[data-pressable-container="true"]')) {
    const a = el.querySelector('a[href*="/post/"]');
    if (!a) continue;
    const u = new URL(a.getAttribute("href"), location.href);
    const t = el.querySelector("time");
    const author = (u.pathname.match(/^\\/@([^/]+)/) || [])[1] || null;
    const actions = [...el.querySelectorAll('[role="button"]')].map((b) => {
      const s = b.querySelector("svg");
      const label = s ? s.getAttribute("aria-label") || (s.querySelector("title") || {}).textContent || "" : "";
      return { label, text: b.innerText.trim() };
    });
    const spans = [...el.querySelectorAll('span[dir="auto"]')].map((s) => s.innerText.trim()).filter(Boolean);
    const text = spans.sort((a, b) => b.length - a.length)[0] || "";
    posts.push({ url: u.origin + u.pathname, author, text, publishedAt: t ? t.getAttribute("datetime") : null, actions });
  }
  const og = (p) => (document.querySelector('meta[property="' + p + '"]') || {}).content || null;
  return {
    logged: /(^|; )ds_user_id=/.test(document.cookie),
    header: (og("og:description") || "") + "\\n" + document.body.innerText.slice(0, 1500),
    name: (og("og:title") || "").replace(/\\s*\\(@[^)]*\\).*$/, "") || null,
    bio: og("og:description"),
    posts,
  };
})()`;

const X_SCRIPT = `(() => {
  const q = (root, sel) => root.querySelector(sel);
  const label = (root, sel) => { const e = q(root, sel); return e ? e.getAttribute("aria-label") : null; };
  const posts = [];
  for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
    const t = q(art, "time");
    const link = t && t.closest("a");
    if (!link) continue;
    const u = new URL(link.getAttribute("href"), location.href);
    posts.push({
      url: u.origin + u.pathname,
      author: (u.pathname.split("/")[1]) || null,
      pinned: /pinned|fixad/i.test((q(art, '[data-testid="socialContext"]') || {}).innerText || ""),
      text: (q(art, '[data-testid="tweetText"]') || {}).innerText || "",
      publishedAt: t.getAttribute("datetime"),
      replies: label(art, '[data-testid="reply"]'),
      reposts: label(art, '[data-testid="retweet"], [data-testid="unretweet"]'),
      likes: label(art, '[data-testid="like"], [data-testid="unlike"]'),
      views: label(art, 'a[href$="/analytics"]'),
    });
  }
  const text = (sel) => (q(document, sel) || {}).innerText || null;
  return {
    logged: /(^|; )twid=/.test(document.cookie),
    header: [text('a[href$="/verified_followers"]'), text('a[href$="/followers"]'), text('a[href$="/following"]')].filter(Boolean).join("\\n"),
    name: (text('[data-testid="UserName"]') || "").split("\\n")[0] || null,
    bio: text('[data-testid="UserDescription"]'),
    posts,
  };
})()`;

// Profile counts come from the page's rehydration JSON, written as header lines profileFromHeader reads.
const TIKTOK_SCRIPT = `(() => {
  let u = null;
  try {
    const j = JSON.parse(document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__").textContent);
    u = j.__DEFAULT_SCOPE__["webapp.user-detail"].userInfo;
  } catch (e) {}
  const st = (u && u.stats) || {};
  const posts = [...document.querySelectorAll('[data-e2e="user-post-item"]')].map((it) => {
    const a = it.querySelector('a[href*="/video/"], a[href*="/photo/"]');
    return a && { url: a.href.split("?")[0], text: (it.querySelector("img") || {}).alt || "", views: (it.querySelector('[data-e2e="video-views"]') || {}).innerText || "" };
  }).filter(Boolean);
  return {
    logged: true, // public profile: an empty read falls to the "nothing readable" error, not a login prompt
    blocked: !!document.querySelector("#captcha-verify-container-main-page, .captcha-verify-container"),
    header: u ? [st.followerCount + " followers", st.followingCount + " following", st.videoCount + " posts"].join("\\n") : "",
    name: u ? u.user.nickname : null,
    bio: u ? u.user.signature : null,
    posts,
  };
})()`;

const SCROLL = `(() => { window.scrollBy(0, Math.round(window.innerHeight * 1.5)); return true; })()`;

type RawPost = Record<string, any> & { url: string };
type RawPage = { logged: boolean; blocked?: boolean; header: string; name: string | null; bio: string | null; posts: RawPost[] };

/** Read the page, scroll, read again; stop at `limit` posts or when a scroll adds nothing. */
async function collect(site: BridgeSite, script: string, limit: number, rounds = 5): Promise<RawPage | null> {
  const first: RawPage | null = await evalOn(site, script);
  if (!first) return null;
  const byUrl = new Map<string, RawPost>();
  for (const p of first.posts || []) byUrl.set(p.url, p);
  for (let i = 0; i < rounds && byUrl.size < limit; i++) {
    const before = byUrl.size;
    await evalOn(site, SCROLL);
    await Bun.sleep(1500);
    const next: RawPage = await evalOn(site, script);
    for (const p of next?.posts || []) if (!byUrl.has(p.url)) byUrl.set(p.url, p);
    if (next?.blocked) first.blocked = true;
    // The header can finish rendering after the first read.
    if (!first.name && next?.name) Object.assign(first, { name: next.name, bio: next.bio, header: next.header, logged: next.logged });
    if (byUrl.size === before) break;
  }
  // A pinned post is old by definition; keep the latest ones first.
  const posts = [...byUrl.values()].sort((a, b) => Number(!!a.pinned) - Number(!!b.pinned));
  return { ...first, posts: posts.slice(0, limit) };
}

// ---------- platform readers ----------

async function watchTikTok(handle: string, url: string, limit: number): Promise<WatchResult> {
  const { tiktokProfile } = await import("./tiktok.js");
  const r = await tiktokProfile(handle, { limit });
  if (!r.ok) return { ok: false, platform: "tiktok", handle, status: r.status === "blocked" ? "blocked" : "error", reason: r.reason };
  return {
    ok: true,
    platform: "tiktok",
    handle,
    url,
    source: r.source === "yt-dlp" ? "yt-dlp" : "browser",
    observedAt: new Date().toISOString(),
    // ponytail: tiktok.ts reads videos only; profile counts stay null until it reads userInfo.
    profile: { name: null, bio: null, followers: null, following: null, posts: null },
    posts: r.items.map((v) => ({
      url: v.url,
      author: v.author || handle,
      text: v.description,
      publishedAt: v.createTime,
      views: v.views,
      likes: v.likes,
      comments: v.comments,
      shares: v.shares,
    })),
  };
}

async function watchFacebook(handle: string, url: string, limit: number): Promise<WatchResult> {
  const posts = await fbPosts(url, limit, { comments: false });
  if (posts.length === 0) return { ok: false, platform: "facebook", handle, status: "error", reason: "no posts read (empty feed, or the page is unavailable)" };
  return {
    ok: true,
    platform: "facebook",
    handle,
    url,
    source: "bridge",
    observedAt: new Date().toISOString(),
    profile: { name: null, bio: null, followers: null, following: null, posts: null },
    posts: posts.map((p) => ({
      url: p.url,
      author: p.author || null,
      text: p.text,
      publishedAt: null, // Facebook shows a tooltip date ("há 2 dias"), not a machine date
      views: null,
      likes: null,
      comments: null,
      shares: null,
    })),
  };
}

const BRIDGE_READERS: Record<"instagram" | "threads" | "x" | "tiktok", { script: string; settleMs: number; toPost: (p: RawPost, handle: string) => WatchPost }> = {
  instagram: {
    script: IG_SCRIPT,
    settleMs: 6000,
    // The grid shows the caption as the image alt and a view count on reels only.
    // ponytail: the grid has no counts any more (reels show only a "Clipe" icon); per-post numbers need opening each post.
    toPost: (p, handle) => ({ url: p.url, author: handle, text: p.text || "", publishedAt: null, views: null, likes: null, comments: null, shares: null }),
  },
  threads: {
    script: THREADS_SCRIPT,
    settleMs: 6000,
    toPost: (p) => ({ url: p.url, author: p.author, text: cleanPostText(p.text || ""), publishedAt: p.publishedAt || null, views: null, ...threadsMetrics(p.actions || []) }),
  },
  tiktok: {
    script: TIKTOK_SCRIPT,
    settleMs: 7000,
    // The grid shows views only; dates, likes and comments come from yt-dlp when it works.
    toPost: (p, handle) => ({ url: p.url, author: handle, text: tiktokCaption(p.text || ""), publishedAt: null, views: leadingNumber(p.views), likes: null, comments: null, shares: null }),
  },
  x: {
    script: X_SCRIPT,
    settleMs: 6000,
    toPost: (p) => {
      return {
        url: p.url,
        author: p.author,
        text: p.text || "",
        publishedAt: p.publishedAt || null,
        views: leadingNumber(p.views),
        likes: leadingNumber(p.likes),
        comments: leadingNumber(p.replies),
        shares: leadingNumber(p.reposts),
      };
    },
  },
};

async function watchOnBridge(platform: "instagram" | "threads" | "x" | "tiktok", handle: string, url: string, limit: number): Promise<WatchResult> {
  const reader = BRIDGE_READERS[platform];
  await navigate(platform, url, reader.settleMs);
  const page = await collect(platform, reader.script, limit);
  if (!page) return { ok: false, platform, handle, status: "error", reason: "page script returned nothing" };
  if (page.blocked && page.posts.length === 0) {
    return { ok: false, platform, handle, status: "blocked", reason: `${platform} shows a CAPTCHA in the bridge Chrome; solve it by hand there (the watcher never does)` };
  }
  if (!page.logged && page.posts.length === 0) {
    return { ok: false, platform, handle, status: "not_logged_in", reason: `${platform} tab in the bridge Chrome is not logged in` };
  }
  const ig = platform === "instagram" ? igNameBio(page.header || "") : null;
  const profile = profileFromHeader(page.header || "", ig ? ig.name : page.name, ig ? ig.bio : platform === "threads" ? threadsBio(page.bio) : page.bio);
  // A session cookie does not mean the profile rendered: an error page reads as nothing at all.
  if (page.posts.length === 0 && !profile.name && profile.followers === null) {
    return { ok: false, platform, handle, status: "error", reason: "nothing readable on the page (error page, removed account, or it did not load)" };
  }
  return {
    ok: true,
    platform,
    handle,
    url,
    source: "bridge",
    observedAt: new Date().toISOString(),
    profile,
    posts: page.posts.map((p) => reader.toPost(p, handle)),
  };
}

// ponytail: one bridge read at a time per process; the MCP server can get overlapping calls,
// and they would share (and navigate) the same per-site tab. Per-site lanes if throughput matters.
let lane: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = lane.then(fn, fn);
  lane = run.catch(() => undefined);
  return run;
}

/** Profile + recent posts of one account. Never throws; failures come back as `{ok:false, status, reason}`. */
export async function watchSocial(target: string, opts: { platform?: string; limit?: number } = {}): Promise<WatchResult> {
  let t: ReturnType<typeof parseWatchTarget>;
  try {
    t = parseWatchTarget(target, opts.platform);
  } catch (err: any) {
    return { ok: false, platform: null, handle: null, status: "invalid_input", reason: err.message };
  }
  const limit = Math.min(Math.max(1, opts.limit || 12), 50);
  return serial(() => readTarget(t, limit));
}

async function readTarget(t: ReturnType<typeof parseWatchTarget>, limit: number): Promise<WatchResult> {
  try {
    let tiktok: WatchResult | null = null;
    if (t.platform === "tiktok") {
      tiktok = await watchTikTok(t.handle, t.url, limit);
      // yt-dlp breaks and the headless browser meets a CAPTCHA; the logged-in bridge tab does not.
      if (tiktok.ok) return tiktok;
    }
    const bridge = await bridgeStatus();
    if (!bridge.ok) return tiktok ?? { ok: false, platform: t.platform, handle: t.handle, status: "bridge_offline", reason: "Chrome bridge not connected (127.0.0.1:8765)" };
    if (t.platform === "facebook") return await watchFacebook(t.handle, t.url, limit);
    return await watchOnBridge(t.platform, t.handle, t.url, limit);
  } catch (err: any) {
    const reason = String(err?.message || err).slice(0, 300);
    const status: WatchStatus = /sem login|not logged|log in/i.test(reason) ? "not_logged_in" : "error";
    return { ok: false, platform: t.platform, handle: t.handle, status, reason };
  }
}
