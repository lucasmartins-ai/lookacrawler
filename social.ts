/**
 * Social readers/writers over the Antigravity browser bridge (127.0.0.1:8765).
 *
 * Logged-in platforms are only ever reached through the user's real Chrome
 * session via the bridge — never a fresh headless browser. Every page script
 * below is a self-contained string run with CDP_EVAL (awaitPromise), so the
 * builders are pure and testable without a browser.
 *
 * Facebook extraction (decoy filtering, post-container anchoring, entity
 * links) is ported from OpenCLI — https://github.com/jackwener/opencli
 * (clis/facebook/feed.js, clis/facebook/search.js), Copyright jackwener,
 * Apache License 2.0 — and extended with pt-BR labels, post URLs and full
 * post text. The Instagram comment write mirrors clis/instagram/comment.js.
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
  const r = await fetch(`${BRIDGE}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

// Shared page-side helpers. Facebook injects zero-width/bidi chars and fake
// digit/spaced-letter nodes to poison scrapers (OpenCLI #2089).
const FB_HELPERS = `
  const clean = (v) => String(v || "").replace(/[\\u200b-\\u200f\\u202a-\\u202e\\u2060\\ufeff]/g, "").replace(/\\s+/g, " ").trim();
  const isDecoy = (t) => !t || /^\\d{8,}$/.test(t) || (/^(?:\\S ){4,}\\S$/.test(t) && t.replace(/\\s/g, "").length <= 12);
  const textOf = (el) => clean(el && el.textContent);
  const isAuthPage = () => /^\\/(login|checkpoint)(\\/|$|\\.php)/.test(location.pathname)
    || /^(Log in to Facebook|Entrar no Facebook|Entre no Facebook)/i.test(textOf(document.body))
    || /You must log in to continue|Você precisa entrar para continuar/i.test(textOf(document.body));
`;

/** pt-BR + en labels. Facebook localises aria-labels, so English-only matching finds nothing in Brazil. */
export const FB_LABELS = {
  postMenu: "^(Actions for this post|Ações para esta publicação|Ações desta publicação|Ações para este post)$",
  like: "^(Like|Curtir)$",
  comment: "^(Comment|Comentar)$",
  share: "^(Share|Compartilhar)$",
  action: "^(Like|Comment|Share|Send|Follow|Curtir|Comentar|Compartilhar|Enviar|Seguir|Responder)$",
  sponsored: "(^|\\s)(Sponsored|Patrocinado)(\\s|$)",
  chrome: "^(People you may know|Suggested for you|Suggested Groups|Pessoas que você talvez conheça|Sugestões para você|Grupos sugeridos|Reels)",
  seeMore: "^(See more|Ver mais)$",
  metric: "^(All:|Todas as reações:)|\\b(likes?|reactions?|comments?|shares?|curtidas?|reações|comentários?|compartilhamentos?)\\b",
  timestamp: "^(\\d+\\s*(s|m|h|d|w|min|sem|a|mo|yr)|Just now|Yesterday|Agora|Ontem)(\\s*[·•.])?$",
};

export function buildFbPostsScript(limit: number): string {
  const L = JSON.stringify(FB_LABELS);
  return `(() => {
    ${FB_HELPERS}
    const L = ${L}; const re = (k) => new RegExp(L[k], "i");
    const limit = ${limit};
    if (isAuthPage()) return { status: "auth", rows: [] };

    const labelOf = (el) => clean(el && el.getAttribute && el.getAttribute("aria-label"));
    // textContent glues sibling nodes ("Loja XPatrocinadoCompre"), so match per element.
    const isSponsored = (root) => Array.from(root.querySelectorAll('[dir="auto"], span, a, [aria-label]'))
      .some((el) => /^(Sponsored|Patrocinado)$/i.test(textOf(el)) || /^(Sponsored|Patrocinado)$/i.test(labelOf(el)));
    const postUrlFrom = (root) => {
      for (const a of root.querySelectorAll("a[href]")) {
        const h = a.href || a.getAttribute("href") || "";
        if (/\\/posts\\/|\\/permalink\\.php|\\/story\\.php|\\/photo\\/\\?fbid=|\\/groups\\/[^/]+\\/(posts|permalink)\\//i.test(h)) return h.split("?")[0];
      }
      return "";
    };
    // Comments are [role=article] nested in the post; keep their text out of the post body.
    const own = (root) => (el) => { const art = el.closest('[role="article"]'); return !art || art === root || !root.contains(art); };
    const blocks = (root) => { const seen = new Set(); return Array.from(root.querySelectorAll('[dir="auto"]')).filter(own(root)).map(textOf).filter((t) => t && t.length <= 2000 && !seen.has(t) && seen.add(t)); };
    const findAuthor = (root) => {
      const links = [root.querySelector("h2 a[href], h3 a[href], h4 a[href], strong a[href]"), ...root.querySelectorAll('a[role="link"][href]')].filter(Boolean);
      for (const a of links) {
        const t = textOf(a), h = a.href || a.getAttribute("href") || "";
        if (t.length > 1 && t.length <= 80 && !re("action").test(t) && !re("metric").test(t) && !re("timestamp").test(t) && !isDecoy(t)
          && !/^[\\d\\s.,-]+$/.test(t) && !/\\/groups\\/[^/]+\\/?$|\\/watch\\/|\\/reel\\/|\\/events\\//i.test(h)) return { name: t, url: h.split("?")[0] };
      }
      return { name: "", url: "" };
    };
    const content = (root, author) => blocks(root).filter((t) => t !== author && t.length > 3
      && !re("chrome").test(t) && !re("sponsored").test(t) && !re("action").test(t) && !re("metric").test(t)
      && !re("timestamp").test(t) && !re("seeMore").test(t) && !isDecoy(t));

    // Anchor on the one "Actions for this post" menu each post has and climb to the
    // highest ancestor that still holds exactly one — that bounds a single post.
    const menus = Array.from(document.querySelectorAll("[aria-label]")).filter((el) => re("postMenu").test(labelOf(el)));
    const countMenus = (n) => Array.from(n.querySelectorAll("[aria-label]")).filter((el) => re("postMenu").test(labelOf(el))).length;
    const LANDMARKS = new Set(["main", "feed", "banner", "navigation", "complementary", "contentinfo", "region"]);
    const containers = [...document.querySelectorAll('[role="article"]')].filter((el) => !el.closest('[role="article"] [role="article"]'));
    for (const m of menus) {
      let node = m.parentElement, best = null;
      for (let d = 0; d < 22 && node && node !== document.body; d++, node = node.parentElement) {
        if (LANDMARKS.has(node.getAttribute("role") || "")) break;
        if (countMenus(node) === 1) best = node; else break;
      }
      if (best && !containers.includes(best)) containers.push(best);
    }

    const rows = [], seen = new Set();
    for (const root of containers) {
      const full = textOf(root);
      if (!full || full.length < 20 || isSponsored(root) || re("chrome").test(full)) continue;
      const author = findAuthor(root);
      const text = clean(content(root, author.name).join(" "));
      const url = postUrlFrom(root);
      const key = url || text.slice(0, 200);
      if (!text || seen.has(key)) continue;
      seen.add(key);
      const comments = Array.from(root.querySelectorAll('[role="article"]')).filter((c) => c !== root).map((c) => {
        const a = findAuthor(c);
        return { author: a.name, authorUrl: a.url, text: clean(content(c, a.name).join(" ")).slice(0, 600) };
      }).filter((c) => c.author && c.text);
      rows.push({ author: author.name, authorUrl: author.url, text: text.slice(0, 1500), url, comments });
      if (rows.length >= limit) break;
    }
    return { status: rows.length ? "ok" : "no_rows", rows, diagnostics: { articles: document.querySelectorAll('[role="article"]').length, menus: menus.length } };
  })()`;
}

const FB_SCROLL = `(async () => { window.scrollTo(0, document.body.scrollHeight); await new Promise((r) => setTimeout(r, 1500)); return document.body.scrollHeight; })()`;

export interface FbPost {
  author: string;
  authorUrl: string;
  text: string;
  url: string;
  source: string;
  comments: Array<{ author: string; authorUrl: string; text: string }>;
}

/** Posts of a Facebook group or page (or any feed URL), with bounded lazy-load scrolling. */
export async function fbPosts(url: string, limit = 20): Promise<FbPost[]> {
  if (!/^https:\/\/(www|m)\.facebook\.com\//.test(url)) throw new Error(`not a facebook.com URL: ${url}`);
  await navigate("facebook", url);
  let rows: any[] = [];
  let lastHeight = 0;
  for (let i = 0; i < 8; i++) {
    const res = await evalOn("facebook", buildFbPostsScript(limit));
    if (res?.status === "auth") throw new Error("Facebook sem login na aba da bridge");
    rows = res?.rows || [];
    if (rows.length >= limit) break;
    const height = await evalOn("facebook", FB_SCROLL);
    if (height === lastHeight) break; // nothing more loaded
    lastHeight = height;
  }
  return rows.slice(0, limit).map((r) => ({ ...r, source: url }));
}

export function buildFbSearchScript(limit: number): string {
  return `(() => {
    ${FB_HELPERS}
    const limit = ${limit};
    if (isAuthPage()) return { status: "auth", rows: [] };
    const isEntity = (href) => {
      let u; try { u = new URL(href, "https://www.facebook.com"); } catch { return false; }
      if (!/(^|\\.)facebook\\.com$/i.test(u.hostname) || /^lm?\\.facebook\\.com$/i.test(u.hostname)) return false;
      const p = u.pathname;
      if (/^\\/search(\\/|$)/i.test(p)) return false; // decoy links back to search
      if (/^\\/(login|checkpoint|help|policies|privacy|settings|bookmarks|messages|notifications|marketplace|gaming|friends|requests|saved|me)\\b/i.test(p)) return false;
      return /^\\/(profile\\.php|photo\\.php|groups\\/|events\\/|watch\\/|reel\\/|pages\\/|permalink\\.php|story\\.php|[^/]+\\/posts\\/|[^/]+\\/videos\\/|[A-Za-z0-9.\\-]{2,}\\/?$)/i.test(p);
    };
    // Keep only identity params: FB appends per-render tracking nonces that defeat dedup.
    const keyOf = (u) => {
      const p = u.pathname.toLowerCase();
      const ids = p === "/profile.php" ? ["id"] : (p === "/permalink.php" || p === "/story.php") ? ["story_fbid", "story_id", "fbid", "id"] : p === "/photo.php" ? ["fbid", "id"] : (p === "/watch" || p === "/watch/") ? ["v"] : [];
      const q = ids.filter((k) => u.searchParams.has(k)).map((k) => k + "=" + u.searchParams.get(k));
      return u.origin + u.pathname + (q.length ? "?" + q.join("&") : "");
    };
    const feed = document.querySelector('[role="feed"]') || document.querySelector('[role="main"]') || document.body;
    const rows = [], seen = new Set();
    for (const a of feed.querySelectorAll("a[href]")) {
      const href = a.href || a.getAttribute("href") || "";
      if (!isEntity(href)) continue;
      const key = keyOf(new URL(href, "https://www.facebook.com"));
      const title = textOf(a).slice(0, 80);
      if (seen.has(key) || !title || isDecoy(title)) continue;
      let card = a;
      for (let i = 0; i < 4 && card.parentElement; i++) { card = card.parentElement; if (textOf(card).length > title.length + 20) break; }
      const text = textOf(card).slice(0, 300);
      if (isDecoy(text)) continue;
      seen.add(key);
      rows.push({ title, text, url: key });
      if (rows.length >= limit) break;
    }
    return { status: rows.length ? "ok" : "no_rows", rows };
  })()`;
}

export async function fbSearch(query: string, limit = 20) {
  const q = query.trim();
  if (!q) throw new Error("search query is empty");
  await navigate("facebook", `https://www.facebook.com/search/posts?q=${encodeURIComponent(q)}`);
  const res = await evalOn("facebook", buildFbSearchScript(limit));
  if (res?.status === "auth") throw new Error("Facebook sem login na aba da bridge");
  return res?.rows || [];
}
