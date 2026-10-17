/**
 * Social readers/writers over the Antigravity browser bridge (127.0.0.1:8765).
 *
 * Logged-in platforms are only ever reached through the user's real Chrome
 * session via the bridge — never a fresh headless browser. Every page script
 * below is a self-contained string run with CDP_EVAL (awaitPromise), so the
 * builders are pure and testable without a browser.
 *
 * Facebook decoy-character stripping follows OpenCLI —
 * https://github.com/jackwener/opencli (clis/facebook/feed.js), Copyright
 * jackwener, Apache License 2.0. The 10/2026 feed reader (story_message,
 * hover-filled permalinks, tooltip dates) is our own.
 * The Instagram comment write mirrors clis/instagram/comment.js.
 */

const BRIDGE = process.env.ANTIGRAVITY_BRIDGE_URL || "http://127.0.0.1:8765";
const IG_APP_ID = "936619743392459";

export type SocialSite = "instagram" | "facebook";
const SITE_DOMAIN: Record<SocialSite, string> = { instagram: "instagram.com", facebook: "facebook.com" };

// ── bridge client ────────────────────────────────────────────────────────────

export async function bridgeStatus(): Promise<{ ok: boolean; detail: any }> {
  try {
    const r = await fetch(`${BRIDGE}/status`, { signal: AbortSignal.timeout(3000) });
    const d: any = await r.json();
    return { ok: d.extension_connected === true && d.websocket_connected === true, detail: d };
  } catch (e: any) {
    return { ok: false, detail: { status: "offline", error: e.message } };
  }
}

async function bridge(payload: Record<string, unknown>, timeoutMs = 15_000): Promise<any> {
  // No keep-alive: the bridge drops idle sockets and Bun reuses them, failing
  // the next call in ~3ms with ECONNRESET ("socket connection was closed").
  const r = await fetch(`${BRIDGE}/api/command`, {
    method: "POST",
    keepalive: false,
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return r.json();
}

/** Run a page script in the site's existing tab. The bridge waits ~8s, so scripts stay short. */
async function evalOn(site: SocialSite, code: string): Promise<any> {
  const r = await bridge({ action: "CDP_EVAL", matchDomain: SITE_DOMAIN[site], code });
  if (!r || r.success === false) throw new Error(r?.error || "bridge eval failed");
  return r.result;
}

async function navigate(site: SocialSite, url: string, settleMs = 5000): Promise<void> {
  const r = await bridge({ action: "NAVIGATE", matchDomain: SITE_DOMAIN[site], url, active: false });
  if (!r || r.success === false) throw new Error(r?.error || `could not open ${url}`);
  await Bun.sleep(settleMs);
}

async function listTabs(): Promise<Array<{ id: number; url: string }>> {
  const r = await bridge({ action: "GET_ALL_TABS" });
  return (r?.tabs || r?.result || []).filter((t: any) => t?.url);
}

// ── doctor ───────────────────────────────────────────────────────────────────

/** Session cookies that are readable from page JS and only exist when logged in. */
export const LOGIN_PROBE = `(() => ({ ig: /(^|; )ds_user_id=/.test(document.cookie), fb: /(^|; )c_user=/.test(document.cookie) }))()`;

/**
 * Side-effect free: reads bridge status and the tabs already open; never
 * navigates or opens a tab (a health check that changes state lies about it).
 */
export async function socialDoctor() {
  const status = await bridgeStatus();
  const sites: Record<string, string> = {};
  if (status.ok) {
    const tabs = await listTabs();
    for (const site of Object.keys(SITE_DOMAIN) as SocialSite[]) {
      if (!tabs.some((t) => t.url.includes(SITE_DOMAIN[site]))) {
        sites[site] = "sem aba aberta (abra o site logado no Chrome)";
        continue;
      }
      try {
        const probe = await evalOn(site, LOGIN_PROBE);
        const logged = site === "instagram" ? probe?.ig : probe?.fb;
        sites[site] = logged ? "logado" : "aba aberta, mas sem login";
      } catch (e: any) {
        sites[site] = `erro: ${e.message}`;
      }
    }
  }
  return { bridge: status.ok ? "conectada" : "offline", bridgeDetail: status.detail, sites };
}

// ── Instagram ────────────────────────────────────────────────────────────────

const SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Instagram post shortcode → numeric media pk (base64url digits, big-endian). */
export function shortcodeToPk(code: string): string {
  let n = 0n;
  for (const ch of code) {
    const v = SHORTCODE_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`invalid shortcode: ${code}`);
    n = n * 64n + BigInt(v);
  }
  return n.toString();
}

export function igPostRef(input: string): { pk: string; url: string } {
  if (/^\d{6,}$/.test(input)) return { pk: input, url: "" };
  const m = input.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`not an Instagram post URL: ${input}`);
  // Private posts carry a long suffix after the 11-char code; the pk only uses the first 11.
  return { pk: shortcodeToPk(m[1].slice(0, 11)), url: `https://www.instagram.com/p/${m[1]}/` };
}

export interface SocialComment {
  id: string;
  user: string;
  text: string;
  createdAt: string;
  postUrl: string;
  replyTo?: string;
}

export function buildIgCommentsScript(pk: string, limit: number): string {
  return `(async () => {
    const pk = ${JSON.stringify(pk)}, limit = ${limit};
    const opts = { credentials: "include", headers: { "x-ig-app-id": "${IG_APP_ID}", "x-requested-with": "XMLHttpRequest" } };
    const rows = [];
    let cursor = "";
    for (let page = 0; page < 10 && rows.length < limit; page++) {
      const r = await fetch("/api/v1/media/" + pk + "/comments/?can_support_threading=true&permalink_enabled=false" + (cursor ? "&min_id=" + encodeURIComponent(cursor) : ""), opts);
      if (r.status === 401 || r.status === 403) return { status: "auth", rows };
      const body = await r.text();
      let j; try { j = JSON.parse(body); } catch { return { status: "not_json", http: r.status, rows }; }
      for (const c of j.comments || []) {
        rows.push({ id: String(c.pk), user: c.user && c.user.username || "", text: c.text || "", createdAt: new Date((c.created_at || 0) * 1000).toISOString() });
        if (rows.length >= limit) break;
      }
      cursor = j.next_min_id || "";
      if (!cursor) break;
    }
    return { status: "ok", rows };
  })()`;
}

export async function igComments(post: string, limit = 50): Promise<SocialComment[]> {
  const ref = igPostRef(post);
  const res = await evalOn("instagram", buildIgCommentsScript(ref.pk, limit));
  if (res?.status === "auth") throw new Error("Instagram sem login na aba da bridge");
  if (res?.status === "not_json") throw new Error(`Instagram respondeu HTML (HTTP ${res.http}); endpoint mudou ou sessão expirou`);
  return (res?.rows || []).map((c: any) => ({ ...c, postUrl: ref.url || post }));
}

export function buildIgAddCommentScript(pk: string, text: string, replyTo?: string): string {
  return `(async () => {
    const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
    const body = new URLSearchParams({ comment_text: ${JSON.stringify(text)} });
    ${replyTo ? `body.set("replied_to_comment_id", ${JSON.stringify(replyTo)});` : ""}
    const r = await fetch("/api/v1/web/comments/" + ${JSON.stringify(pk)} + "/add/", {
      method: "POST", credentials: "include",
      headers: { "x-ig-app-id": "${IG_APP_ID}", "x-csrftoken": csrf, "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    let j = null; try { j = await r.json(); } catch {}
    return { http: r.status, ok: r.ok && j && j.status === "ok", id: j && j.id ? String(j.id) : null };
  })()`;
}

/**
 * Comment (or reply to a comment) on an Instagram post. Dry-run unless
 * `live` is set: an outbound comment is published under the user's name.
 */
export async function igComment(post: string, text: string, opts: { replyTo?: string; live?: boolean } = {}) {
  const t = text.trim();
  if (!t) throw new Error("comment text is empty");
  if (t.length > 2200) throw new Error("Instagram comments are limited to 2200 characters");
  const ref = igPostRef(post);
  if (!opts.live) return { dryRun: true, pk: ref.pk, replyTo: opts.replyTo ?? null, text: t };
  const res = await evalOn("instagram", buildIgAddCommentScript(ref.pk, t, opts.replyTo));
  if (!res?.ok) throw new Error(`Instagram recusou o comentário (HTTP ${res?.http})`);
  return { dryRun: false, pk: ref.pk, replyTo: opts.replyTo ?? null, text: t, commentId: res.id };
}

// ── Facebook ─────────────────────────────────────────────────────────────────

// Shared page-side helpers. Facebook injects zero-width/bidi/grapheme-joiner
// chars and fake digit/spaced-letter nodes to poison scrapers (OpenCLI #2089).
const FB_HELPERS = `
  const clean = (v) => String(v || "").replace(/[\\u034f\\u200b-\\u200f\\u202a-\\u202e\\u2060\\ufeff]/g, "").replace(/\\s+/g, " ").trim();
  const textOf = (el) => clean(el && el.textContent);
  const isAuthPage = () => /^\\/(login|checkpoint)(\\/|$|\\.php)/.test(location.pathname)
    || /^(Log in to Facebook|Entrar no Facebook|Entre no Facebook)/i.test(textOf(document.body))
    || /You must log in to continue|Você precisa entrar para continuar/i.test(textOf(document.body));
`;

/**
 * Feed items of a group, page or post search (Facebook layout of 10/2026).
 *
 * Measured on a public group in pt-BR: [role=article] is empty, visible
 * innerText is decoy, and the post body sits in
 * [data-ad-rendering-role=story_message] (older builds: [data-ad-preview=message]).
 * The permalink is a bare "?__cft__" href that Facebook only fills in on
 * hover, so the script hovers those links first. In search results the
 * permalink is /groups/<id>/?multi_permalinks=<post id>. The post date only
 * exists as the timestamp link's hover tooltip; dates are read for posts not
 * in `known`, within a time budget, because the bridge gives an eval ~8s.
 */
export function buildFbPostsScript(limit: number, known: string[] = [], dateBudgetMs = 3000): string {
  return `(async () => {
    ${FB_HELPERS}
    const limit = ${limit}, known = new Set(${JSON.stringify(known)}), budget = ${dateBudgetMs};
    if (isAuthPage()) return { status: "auth", rows: [] };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const abs = (h) => { try { return new URL(h, "https://www.facebook.com"); } catch { return null; } };
    const MSG = '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]';

    // A post URL in any of the shapes Facebook uses, canonicalised (no tracking params).
    const postUrlOf = (href) => {
      const u = abs(href); if (!u || !/(^|\\.)facebook\\.com$/.test(u.hostname)) return "";
      const p = u.pathname, q = u.searchParams;
      let m = p.match(/^\\/groups\\/([^/]+)\\/(?:posts|permalink)\\/(\\d+)/);
      if (m) return "https://www.facebook.com/groups/" + m[1] + "/posts/" + m[2] + "/";
      m = p.match(/^\\/groups\\/([^/]+)\\/?$/);
      if (m && /^\\d+$/.test(q.get("multi_permalinks") || "")) return "https://www.facebook.com/groups/" + m[1] + "/posts/" + q.get("multi_permalinks") + "/";
      if ((p === "/permalink.php" || p === "/story.php") && q.get("story_fbid")) return "https://www.facebook.com" + p + "?story_fbid=" + q.get("story_fbid") + (q.get("id") ? "&id=" + q.get("id") : "");
      m = p.match(/^\\/([^/]+)\\/posts\\/([\\w-]+)/);
      if (m) return "https://www.facebook.com/" + m[1] + "/posts/" + m[2] + "/";
      return "";
    };
    const pathOf = (a) => { const u = abs(a.getAttribute("href") || ""); return u ? u.origin + u.pathname : ""; };

    const groupText = textOf(document.querySelector('[role="main"]') || document.body).slice(0, 6000);
    const groupPublic = !/^\\/groups\\//.test(location.pathname) ? null
      : /Grupo [Pp]úblico|Public group/.test(groupText) ? true
      : /Grupo [Pp]rivado|Private group/.test(groupText) ? false : null;

    // One item per feed child that holds a post body.
    const feed = document.querySelector('[role="feed"]') || document.querySelector('[role="main"]') || document.body;
    const items = [];
    for (const m of document.querySelectorAll(MSG)) {
      let c = m;
      while (c.parentElement && c.parentElement !== feed && c.parentElement !== document.body) c = c.parentElement;
      if (!items.includes(c)) items.push(c);
    }

    // Permalinks are filled in on hover.
    const bare = (item) => Array.from(item.querySelectorAll("a")).filter((a) => !a.closest(MSG) && /^(\\?|#|$)/.test(a.getAttribute("href") || ""));
    const fire = (a, types) => { const r = a.getBoundingClientRect(); for (const t of types) a.dispatchEvent(new (t.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : t.startsWith("focus") || t === "blur" ? FocusEvent : MouseEvent)(t, { bubbles: !/enter|leave|^focus$|blur/.test(t), clientX: r.x + 2, clientY: r.y + 2 })); };
    const hover = (a) => fire(a, ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove", "focus", "focusin"]);
    const unhover = (a) => fire(a, ["pointerout", "pointerleave", "mouseout", "mouseleave", "blur"]);
    const tips = () => Array.from(document.querySelectorAll('[role="tooltip"]'));
    const pending = items.flatMap(bare);
    pending.forEach(hover);
    if (pending.length) { await sleep(500); pending.forEach(unhover); for (let w = 0; w < 10 && tips().length; w++) await sleep(50); }

    const rows = [], started = Date.now();
    for (const item of items) {
      const msg = item.querySelector(MSG);
      // Long posts end in "… Ver mais"; expanding needs a click, so keep the preview.
      const text = clean(msg.innerText || msg.textContent).replace(/\\s*(…|[.]{3})?\\s*(Ver mais|See more)$/i, "");
      if (!text) continue;
      const links = Array.from(item.querySelectorAll("a[href]")).filter((a) => !a.closest(MSG) && !a.closest('[role="article"]'));
      const stamp = links.find((a) => postUrlOf(a.href || a.getAttribute("href")));
      const url = stamp ? postUrlOf(stamp.href || stamp.getAttribute("href")) : "";
      const person = links.find((a) => /\\/user\\/\\d+|\\/profile\\.php|\\/people\\//.test(pathOf(a)) && textOf(a));
      const nameEl = item.querySelector('[data-ad-rendering-role="profile_name"]');
      const author = person ? textOf(person) : textOf(nameEl).replace(/\\s*·.*$/, "");
      const groupLink = links.find((a) => /^https:\\/\\/www\\.facebook\\.com\\/groups\\/[^/]+\\/?$/.test(pathOf(a)) && (textOf(a) || a.getAttribute("aria-label")));
      const group = groupLink ? { name: textOf(groupLink) || clean(groupLink.getAttribute("aria-label")), url: pathOf(groupLink) } : null;
      let date = "";
      if (stamp && !known.has(url) && Date.now() - started < budget) {
        // Tooltips stack while hovered; take the one this hover adds.
        const before = new Set(tips());
        hover(stamp);
        for (let w = 0; w < 12 && !date; w++) { await sleep(50); date = textOf(tips().find((t) => !before.has(t))); }
        unhover(stamp);
      }
      const comments = Array.from(item.querySelectorAll('[role="article"]')).map((c) => {
        const a = c.querySelector("a[href]");
        const name = textOf(a);
        const body = Array.from(c.querySelectorAll('[dir="auto"]')).map(textOf).filter((t) => t && t !== name);
        return { author: name, authorUrl: a ? pathOf(a) : "", text: clean([...new Set(body)].join(" ")).slice(0, 600) };
      }).filter((c) => c.author && c.text);
      rows.push({ author, authorUrl: person ? pathOf(person) : "", text: text.slice(0, 3000), url, date, group, comments });
      if (rows.length >= limit) break;
    }
    return { status: rows.length ? "ok" : "no_rows", groupPublic, rows, diagnostics: { items: items.length, noUrl: rows.filter((r) => !r.url).length } };
  })()`;
}

const PT_MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const EN_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Facebook's timestamp tooltip ("Quinta, 15 de outubro de 2026 às 01:38") → "2026-10-15T01:38" (viewer's local time). Unknown shapes pass through. */
export function parseFbDate(s: string): string {
  const pad = (n: number | string) => String(n).padStart(2, "0");
  let m = s.match(/(\d{1,2}) de (\p{L}+) de (\d{4})(?: às (\d{1,2}):(\d{2}))?/iu);
  if (m && PT_MONTHS.includes(m[2].toLowerCase())) return `${m[3]}-${pad(PT_MONTHS.indexOf(m[2].toLowerCase()) + 1)}-${pad(m[1])}` + (m[4] ? `T${pad(m[4])}:${m[5]}` : "");
  m = s.match(/(\p{L}+) (\d{1,2}), (\d{4})(?: at (\d{1,2}):(\d{2}) ?([AP]M))?/iu);
  if (m && EN_MONTHS.includes(m[1].toLowerCase())) {
    const h = m[4] ? (Number(m[4]) % 12) + (/PM/i.test(m[6]) ? 12 : 0) : null;
    return `${m[3]}-${pad(EN_MONTHS.indexOf(m[1].toLowerCase()) + 1)}-${pad(m[2])}` + (h !== null ? `T${pad(h)}:${m[5]}` : "");
  }
  return s;
}

// Step by viewport, not to the bottom: the feed is virtualised and a jump skips items.
const FB_SCROLL = `(async () => { window.scrollBy(0, Math.round(window.innerHeight * 1.5)); await new Promise((r) => setTimeout(r, 1500)); return window.scrollY; })()`;

export interface FbPost {
  author: string;
  authorUrl: string;
  text: string;
  url: string;
  date: string;
  group: { name: string; url: string } | null;
  /** Public group per its header; null when not a group page or not shown. */
  groupPublic: boolean | null;
  source: string;
  comments: Array<{ author: string; authorUrl: string; text: string }>;
}

/** Scroll the open feed and collect posts that have a permalink (an item without one is useless downstream). */
async function collectFbFeed(source: string, limit: number): Promise<FbPost[]> {
  const byUrl = new Map<string, FbPost>();
  let groupPublic: boolean | null = null;
  for (let i = 0, idle = 0; i < 20 && byUrl.size < limit && idle < 3; i++) {
    const res = await evalOn("facebook", buildFbPostsScript(limit, [...byUrl.keys()]));
    if (res?.status === "auth") throw new Error("Facebook sem login na aba da bridge");
    groupPublic ??= res?.groupPublic ?? null;
    const before = byUrl.size;
    for (const r of res?.rows || []) {
      if (!r.url || byUrl.has(r.url)) continue;
      byUrl.set(r.url, { ...r, date: r.date ? parseFbDate(r.date) : "", groupPublic, source });
    }
    idle = byUrl.size === before ? idle + 1 : 0;
    if (byUrl.size < limit) await evalOn("facebook", FB_SCROLL);
  }
  return [...byUrl.values()].slice(0, limit).map((p) => ({ ...p, groupPublic: p.groupPublic ?? groupPublic }));
}

/** Posts of a Facebook group or page (or any feed URL). Read-only. */
export async function fbPosts(url: string, limit = 20): Promise<FbPost[]> {
  if (!/^https:\/\/(www|m)\.facebook\.com\//.test(url)) throw new Error(`not a facebook.com URL: ${url}`);
  await navigate("facebook", url);
  return collectFbFeed(url, limit);
}

/** Post search ("/search/posts"). Rows carry the group they were posted in; groupPublic is unknown here (null). */
export async function fbSearch(query: string, limit = 20): Promise<FbPost[]> {
  const q = query.trim();
  if (!q) throw new Error("search query is empty");
  const url = `https://www.facebook.com/search/posts?q=${encodeURIComponent(q)}`;
  await navigate("facebook", url);
  return collectFbFeed(url, limit);
}
