import { fetchHtml } from "./extractor.js";
import { classifyFailure } from "./errors.js";

/**
 * robots.txt (RFC 9309) for `crawl` and `map`. Single-URL `extract` is a user
 * request, not a crawl, and does not consult it.
 *
 * Our fetches send a browser User-Agent, so the product token we answer to is
 * fixed: a group for `lookacrawler` replaces the `*` group.
 */
export const ROBOTS_PRODUCT_TOKEN = "lookacrawler";

export type RobotsState = "applied" | "none" | "unreachable" | "ignored";

export interface Robots {
  state: RobotsState;
  sitemaps: string[];
  isAllowed(url: string): boolean;
}

interface Rule {
  allow: boolean;
  pattern: string;
}

/**
 * Match a robots path pattern against path+query. `*` is any run of
 * characters, a trailing `$` anchors the end. Segment search, not a regex:
 * robots.txt is attacker-controlled input (same stance as compileUrlPatterns).
 */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  if (!path.startsWith(parts[0])) return false;
  let at = parts[0].length;
  const last = parts.length - 1;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    // An anchored pattern's last literal must end the path, after what matched so far.
    if (anchored && i === last) return path.length - part.length >= at && path.endsWith(part);
    if (!part) continue;
    // Leftmost match for the middle literals leaves the most room for the rest.
    const idx = path.indexOf(part, at);
    if (idx < 0) return false;
    at = idx + part.length;
  }
  return !anchored || at === path.length;
}

/** Parse robots.txt and pick the rules that apply to `agent` (default: our token). */
export function parseRobots(txt: string, agent = ROBOTS_PRODUCT_TOKEN): { rules: Rule[]; sitemaps: string[] } {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;

  for (const rawLine of txt.split(/\r?\n|\r/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      // An empty Disallow allows everything; rules outside a group are ignored.
      if (current && value) current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "sitemap") {
      if (/^https?:\/\//i.test(value) && !sitemaps.includes(value)) sitemaps.push(value);
    } else {
      lastWasAgent = false;
    }
  }

  const token = agent.toLowerCase();
  const specific = groups.filter((g) => g.agents.includes(token));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  return { rules: chosen.flatMap((g) => g.rules), sitemaps };
}

/** Longest matching rule wins; Allow wins a tie; no match means allowed. */
export function isPathAllowed(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!robotsPatternMatches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return !best || best.allow;
}

function pathOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

/** Robots for text already fetched. Exported for tests and for map's single fetch. */
export function robotsFromText(origin: string, txt: string): Robots {
  // A 200 that serves the SPA shell instead of robots.txt has no rules to obey.
  if (/^\s*</.test(txt)) return { state: "none", sitemaps: [], isAllowed: () => true };
  const { rules, sitemaps } = parseRobots(txt);
  const host = new URL(origin).hostname;
  return {
    state: "applied",
    sitemaps,
    isAllowed: (url) => {
      const path = pathOf(url);
      if (path === null) return false;
      // Same host on either scheme is governed by these rules: we never fetch a second robots.txt.
      if (new URL(url).hostname !== host || path === "/robots.txt") return true;
      return isPathAllowed(rules, path);
    },
  };
}

const ALLOW_ALL = (state: RobotsState): Robots => ({ state, sitemaps: [], isAllowed: () => true });

/**
 * Fetch and parse `<origin>/robots.txt`.
 *  - 4xx other than 429, or a 200 challenge page: no usable rules, allow all.
 *  - 429, 5xx, timeout, connection failure: RFC 9309 §2.3.1.4 says assume
 *    complete disallow, so nothing is crawled and the result says "unreachable".
 */
export async function loadRobots(origin: string, options: { ignore?: boolean; timeoutMs?: number } = {}): Promise<Robots> {
  if (options.ignore) return ALLOW_ALL("ignored");
  try {
    const txt = await fetchHtml(`${origin}/robots.txt`, { timeoutMs: options.timeoutMs ?? 5000 });
    return robotsFromText(origin, txt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // "HTTP 404: ..." from fetchHtml, or "Anti-Bot protection triggered: HTTP Status 503 ..." from detectAntiBot.
    const status = Number(/HTTP (?:Status )?(\d{3})/.exec(message)?.[1] || 0);
    if (status >= 400 && status < 500 && status !== 429) return ALLOW_ALL("none");
    // A challenge page served with 200 hides the file: no rules we could read.
    if (!status && classifyFailure(err) === "anti_bot") return ALLOW_ALL("none");
    return { state: "unreachable", sitemaps: [], isAllowed: () => false };
  }
}
