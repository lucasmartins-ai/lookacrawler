/**
 * Public social lookup: profile meta tags (Instagram, LinkedIn, X) and Reddit
 * .json search. No API keys, no login (for logged-in access use social.ts).
 * Every request goes through fetchHtml, so the SSRF / egress guard, rate
 * limiter and size cap apply. Profile pages are often login-walled; a failed
 * lookup degrades to a summary line instead of throwing.
 */

import { fetchHtml } from "./extractor.js";

export type SocialPlatform = "instagram" | "linkedin" | "reddit" | "twitter" | "unknown";

export interface SocialProfile {
  platform: SocialPlatform;
  url: string;
  handle?: string;
  name?: string;
  bio?: string;
  followers?: number;
  following?: number;
  postsCount?: number;
  verified?: boolean;
  isBusinessAccount?: boolean;
  externalUrl?: string;
  companySize?: string;
  industry?: string;
  headline?: string;
  recentActivitySummary?: string;
  intentSignals?: string[];
  extractedAt: string;
  tokenSummary: string; // Compact summary, < 80 tokens
}

export interface RedditIntentPost {
  id: string;
  title: string;
  subreddit: string;
  author: string;
  url: string;
  permalink: string;
  score: number;
  numComments: number;
  createdAt: string;
  snippet: string;
  intentCategory: "recommendation_request" | "problem_complaint" | "hiring_service" | "general_discussion";
}

export interface RedditIntentSearchResult {
  query: string;
  subreddit?: string;
  totalFound: number;
  posts: RedditIntentPost[];
  summaryText: string;
}

/**
 * Detect social platform from a given URL.
 */
export function detectSocialPlatform(rawUrl: string): SocialPlatform {
  try {
    const urlObj = new URL(rawUrl);
    const host = urlObj.hostname.toLowerCase();
    const is = (d: string) => host === d || host.endsWith(`.${d}`);
    if (is("instagram.com")) return "instagram";
    if (is("linkedin.com")) return "linkedin";
    if (is("reddit.com")) return "reddit";
    if (is("twitter.com") || is("x.com")) return "twitter";
  } catch {}
  return "unknown";
}

/**
 * Helper to parse shorthand numbers (e.g. "12.5K", "1.2M", "350", "10.000", "5,2 mil").
 */
export function parseShorthandNumber(str?: string | null): number | undefined {
  if (!str) return undefined;
  const trimmed = str.trim();
  if (!trimmed) return undefined;

  let multiplier = 1;
  let numStr = trimmed;

  if (/\b(?:mil|k)\b/i.test(trimmed) || /[0-9]k\b/i.test(trimmed)) {
    multiplier = 1000;
    numStr = trimmed.replace(/\b(?:mil|k)\b/gi, "").replace(/k$/i, "").trim();
  } else if (/\b(?:mi|milh(?:ão|ões)|m)\b/i.test(trimmed) || /[0-9]m\b/i.test(trimmed)) {
    multiplier = 1000000;
    numStr = trimmed.replace(/\b(?:mi|milh(?:ão|ões)|m)\b/gi, "").replace(/m$/i, "").trim();
  } else if (/\b(?:bi|bilh(?:ão|ões)|b)\b/i.test(trimmed) || /[0-9]b\b/i.test(trimmed)) {
    multiplier = 1000000000;
    numStr = trimmed.replace(/\b(?:bi|bilh(?:ão|ões)|b)\b/gi, "").replace(/b$/i, "").trim();
  }

  // If multiplier was found (e.g. "12.5k" or "12,5 mil"), comma or dot is decimal separator
  if (multiplier > 1) {
    const normalized = numStr.replace(/,/g, ".");
    const val = parseFloat(normalized);
    return isNaN(val) ? undefined : Math.round(val * multiplier);
  }

  // If no multiplier, check if dot/comma is thousands separator (e.g. "10.000" or "10,000")
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(numStr)) {
    const cleanDigits = numStr.replace(/[^\d]/g, "");
    return parseInt(cleanDigits, 10);
  }

  // Plain number or simple decimal
  const cleanDecimal = numStr.replace(/,/g, ".");
  const plainVal = parseFloat(cleanDecimal);
  return isNaN(plainVal) ? undefined : Math.round(plainVal);
}

/**
 * Extract meta tag content by property or name from HTML.
 */
export function extractMetaTag(html: string, nameOrProperty: string): string | undefined {
  // Bounded scan: one unbounded `<meta[^>]*...` regex over a hostile page with
  // thousands of unclosed `<meta ` tags went quadratic (240 KB took 18 s). Meta
  // tags live in <head>, so the first 200 KB and 1 KB per tag are plenty.
  const want = nameOrProperty.toLowerCase();
  const attr = (tag: string, name: string) =>
    tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"))?.slice(1).find((v) => v !== undefined);
  for (const [tag] of html.slice(0, 200_000).matchAll(/<meta\b[^>]{0,1000}>/gi)) {
    const key = attr(tag, "property") ?? attr(tag, "name");
    if (key?.toLowerCase() !== want) continue;
    const content = attr(tag, "content")?.trim();
    if (content) return content;
  }
  return undefined;
}

/**
 * Parse Instagram profile public HTML or OpenGraph metadata.
 */
export function parseInstagramHtml(html: string, targetUrl: string): SocialProfile {
  let handle: string | undefined = undefined;
  const urlMatch = targetUrl.match(/instagram\.com\/([a-zA-Z0-9._-]+)/i);
  if (urlMatch && urlMatch[1] && !["p", "reel", "explore", "stories"].includes(urlMatch[1].toLowerCase())) {
    handle = urlMatch[1];
  }

  const ogTitle = extractMetaTag(html, "og:title") || "";
  const ogDescription = extractMetaTag(html, "og:description") || "";
  
  let name: string | undefined = undefined;
  let followers: number | undefined = undefined;
  let following: number | undefined = undefined;
  let postsCount: number | undefined = undefined;
  let bio: string | undefined = undefined;
  let verified = false;

  // Check verified badge markers
  if (
    html.includes('"is_verified":true') ||
    html.includes('"verified":true') ||
    ogDescription.includes("Verified")
  ) {
    verified = true;
  }

  // Parse title: "Name (@handle) • Instagram photos and videos"
  const titleMatch = ogTitle.match(/^([^(@]+)(?:\s*\(@([a-zA-Z0-9._-]+)\))?/i);
  if (titleMatch) {
    name = titleMatch[1].replace(/•.*/, "").trim();
    if (titleMatch[2] && !handle) handle = titleMatch[2].trim();
  }

  // Parse description: "12.5K Followers, 450 Following, 320 Posts - See Instagram photos and videos from Dra. Ana (@dra.ana)"
  // Or in Portuguese: "12,5 mil seguidores, 450 seguindo, 320 publicações..."
  const descMatch = ogDescription.match(
    /([\d.,]+\s*[KkMm]?)\s*(?:Followers|seguidores)[,\s]+([\d.,]+\s*[KkMm]?)\s*(?:Following|seguindo)[,\s]+([\d.,]+\s*[KkMm]?)\s*(?:Posts|publicações)/i
  );

  if (descMatch) {
    followers = parseShorthandNumber(descMatch[1]);
    following = parseShorthandNumber(descMatch[2]);
    postsCount = parseShorthandNumber(descMatch[3]);

    // Bio often follows after the dash/hyphen
    const bioPart = ogDescription.replace(/^.*?[–-]\s*/, "").trim();
    if (bioPart && !bioPart.toLowerCase().startsWith("see instagram")) {
      bio = bioPart;
    }
  } else {
    // Fallback: look for individual regex patterns
    const folMatch = ogDescription.match(/([\d.,]+\s*[KkMm]?)\s*(?:Followers|seguidores)/i);
    if (folMatch) followers = parseShorthandNumber(folMatch[1]);
  }

  // Try extracting bio from JSON-LD if present
  const ldJsonMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  if (ldJsonMatch) {
    try {
      const data = JSON.parse(ldJsonMatch[1]);
      if (data.description && !bio) bio = data.description;
      if (data.name && !name) name = data.name;
    } catch {}
  }

  // Detect commercial/business profile
  const isBusinessAccount =
    html.includes('"is_business_account":true') ||
    html.includes('"is_professional_account":true') ||
    Boolean(bio && /(?:contato|agendamentos|consultas|crm|cro|oab|cnpj|direct|linktr\.ee)/i.test(bio));

  // External URL in bio (linktree, whatsapp, etc.)
  let externalUrl: string | undefined = undefined;
  if (bio) {
    const extMatch = bio.match(/https?:\/\/[^\s]+/i);
    if (extMatch) externalUrl = extMatch[0];
  }

  // Generate concise < 80 token summary
  const handleStr = handle ? `@${handle}` : name || "Instagram Profile";
  const followersStr = followers !== undefined ? `${followers.toLocaleString("pt-BR")} seguidores` : "Seguidores N/D";
  const verifiedStr = verified ? " [Verificado]" : "";
  const bizStr = isBusinessAccount ? " [Comercial]" : "";
  const bioExcerpt = bio ? ` | Bio: "${bio.slice(0, 100).replace(/\s+/g, " ").trim()}"` : "";

  const tokenSummary = `[Instagram ${handleStr}${verifiedStr}${bizStr}] ${followersStr}${bioExcerpt}`;

  return {
    platform: "instagram",
    url: targetUrl,
    handle,
    name,
    bio,
    followers,
    following,
    postsCount,
    verified,
    isBusinessAccount,
    externalUrl,
    extractedAt: new Date().toISOString(),
    tokenSummary,
  };
}

/**
 * Parse LinkedIn company or person public OpenGraph metadata.
 */
export function parseLinkedInHtml(html: string, targetUrl: string): SocialProfile {
  let handle: string | undefined = undefined;
  const isCompany = targetUrl.toLowerCase().includes("/company/");

  const urlMatch = targetUrl.match(/linkedin\.com\/(?:company|in)\/([a-zA-Z0-9._-]+)/i);
  if (urlMatch && urlMatch[1]) {
    handle = urlMatch[1];
  }

  const ogTitle = extractMetaTag(html, "og:title") || "";
  const ogDescription = extractMetaTag(html, "og:description") || "";

  let name = ogTitle.replace(/\s*\|\s*LinkedIn.*$/i, "").trim() || handle;
  let headline: string | undefined = undefined;
  let companySize: string | undefined = undefined;
  let industry: string | undefined = undefined;
  let followers: number | undefined = undefined;

  if (isCompany) {
    // Format in LinkedIn Company description:
    // "Empresa XYZ | 51-200 funcionários | Software e Serviços | São Paulo"
    // or: "Empresa XYZ tem 1.250 seguidores no LinkedIn..."
    const folMatch = ogDescription.match(/([\d.,]+\s*[KkMm]?)\s*(?:followers|seguidores)/i);
    if (folMatch) {
      followers = parseShorthandNumber(folMatch[1]);
    }

    const sizeMatch = ogDescription.match(/(\d+[\d\s–-]*\+?\s*funcionários|\d+[\d\s–-]*\+?\s*employees)/i);
    if (sizeMatch) {
      companySize = sizeMatch[1].trim();
    }

    const parts = ogDescription.split("|").map((p) => p.trim());
    for (const part of parts) {
      if (
        part !== name &&
        !part.match(/funcionários|employees/i) &&
        !part.match(/seguidores|followers/i) &&
        !industry
      ) {
        industry = part;
      }
    }
  } else {
    // Person profile
    headline = ogDescription || ogTitle;
  }

  const label = isCompany ? "LinkedIn Empresa" : "LinkedIn Perfil";
  const followersStr = followers !== undefined ? ` | ${followers.toLocaleString("pt-BR")} seguidores` : "";
  const sizeStr = companySize ? ` | Porte: ${companySize}` : "";
  const indStr = industry ? ` | Setor: ${industry}` : "";
  const headStr = headline ? ` | Headline: "${headline.slice(0, 80)}"` : "";

  const tokenSummary = `[${label} ${name}]${followersStr}${sizeStr}${indStr}${headStr}`;

  return {
    platform: "linkedin",
    url: targetUrl,
    handle,
    name,
    headline,
    companySize,
    industry,
    followers,
    extractedAt: new Date().toISOString(),
    tokenSummary,
  };
}

/**
 * Parse Twitter/X public OpenGraph tags.
 */
export function parseTwitterHtml(html: string, targetUrl: string): SocialProfile {
  let handle: string | undefined = undefined;
  const urlMatch = targetUrl.match(/(?:twitter|x)\.com\/([a-zA-Z0-9_]+)/i);
  if (urlMatch && urlMatch[1] && !["home", "explore", "search"].includes(urlMatch[1].toLowerCase())) {
    handle = urlMatch[1];
  }

  const ogTitle = extractMetaTag(html, "og:title") || "";
  const ogDescription = extractMetaTag(html, "og:description") || "";

  const name = ogTitle.replace(/\s*\(@[a-zA-Z0-9_]+\)\s*\/.*$/i, "").trim() || handle;
  const bio = ogDescription;

  const handleStr = handle ? `@${handle}` : name || "Twitter Profile";
  const bioStr = bio ? ` | Bio: "${bio.slice(0, 80)}"` : "";
  const tokenSummary = `[Twitter/X ${handleStr}]${bioStr}`;

  return {
    platform: "twitter",
    url: targetUrl,
    handle,
    name,
    bio,
    extractedAt: new Date().toISOString(),
    tokenSummary,
  };
}

/**
 * Parse native Reddit search JSON payload into structured intent posts.
 */
export function parseRedditJson(jsonData: any, query?: string): RedditIntentPost[] {
  const posts: RedditIntentPost[] = [];
  const children = jsonData?.data?.children || [];

  const recommendationKeywords = [
    "recomendações",
    "recomenda",
    "indica",
    "indicação",
    "alguém conhece",
    "melhor",
    "onde encontrar",
    "recommend",
    "suggestions",
  ];
  const problemKeywords = [
    "problema",
    "reclamação",
    "não presta",
    "dor de cabeça",
    "ruim",
    "golpe",
    "insatisfeito",
    "issue",
    "broken",
    "bad service",
  ];
  const hiringKeywords = [
    "contratar",
    "orçamento",
    "preço",
    "quanto custa",
    "serviço",
    "freela",
    "hire",
    "quote",
  ];

  for (const child of children) {
    const postData = child?.data;
    if (!postData || !postData.title) continue;

    const fullText = `${postData.title} ${postData.selftext || ""}`.toLowerCase();

    let intentCategory: RedditIntentPost["intentCategory"] = "general_discussion";
    if (recommendationKeywords.some((kw) => fullText.includes(kw))) {
      intentCategory = "recommendation_request";
    } else if (problemKeywords.some((kw) => fullText.includes(kw))) {
      intentCategory = "problem_complaint";
    } else if (hiringKeywords.some((kw) => fullText.includes(kw))) {
      intentCategory = "hiring_service";
    }

    posts.push({
      id: postData.id,
      title: postData.title,
      subreddit: postData.subreddit || "unknown",
      author: postData.author || "anonymous",
      url: postData.url || `https://reddit.com${postData.permalink}`,
      permalink: `https://reddit.com${postData.permalink}`,
      score: postData.score || 0,
      numComments: postData.num_comments || 0,
      createdAt: new Date((postData.created_utc || Date.now() / 1000) * 1000).toISOString(),
      snippet: (postData.selftext || postData.title).slice(0, 200).replace(/\s+/g, " ").trim(),
      intentCategory,
    });
  }

  return posts;
}

/** Text fetcher; defaults to the guarded fetchHtml. Injectable so tests stay offline. */
export type FetchText = (url: string, options?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<string>;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * Fetch and extract public social intelligence from a profile URL.
 */
export async function lookupSocialProfile(
  url: string,
  options: { fetchText?: FetchText; timeoutMs?: number } = {}
): Promise<SocialProfile> {
  const fetchText = options.fetchText || fetchHtml;
  const timeoutMs = options.timeoutMs || 8000;
  const platform = detectSocialPlatform(url);

  if (platform === "unknown") {
    return {
      platform: "unknown",
      url,
      extractedAt: new Date().toISOString(),
      tokenSummary: `[Web Link] ${url}`,
    };
  }

  try {
    const html = await fetchText(url, {
      timeoutMs,
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" },
    });

    switch (platform) {
      case "instagram":
        return parseInstagramHtml(html, url);
      case "linkedin":
        return parseLinkedInHtml(html, url);
      case "twitter":
        return parseTwitterHtml(html, url);
      default:
        return {
          platform,
          url,
          extractedAt: new Date().toISOString(),
          tokenSummary: `[${platform} Profile] ${url}`,
        };
    }
  } catch (err: any) {
    return {
      platform,
      url,
      extractedAt: new Date().toISOString(),
      tokenSummary: `[${platform} Profile] ${url} (unavailable: ${err?.message || "error"})`,
    };
  }
}

/**
 * Search consumer/business buying intent signals on Reddit without API keys.
 */
export async function searchRedditIntent(
  query: string,
  options: { subreddit?: string; limit?: number; fetchText?: FetchText; timeoutMs?: number } = {}
): Promise<RedditIntentSearchResult> {
  const fetchText = options.fetchText || fetchHtml;
  const timeoutMs = options.timeoutMs || 8000;
  const limit = Math.max(1, Math.min(25, options.limit || 5));
  const { subreddit } = options;
  // The name lands in the URL path: keep it to Reddit's own charset.
  if (subreddit && !/^[A-Za-z0-9_]{2,21}$/.test(subreddit)) {
    throw new Error("Invalid subreddit name");
  }

  const q = encodeURIComponent(query);
  const endpoint = subreddit
    ? `https://www.reddit.com/r/${subreddit}/search.json?q=${q}&restrict_sr=1&sort=new&limit=${limit}`
    : `https://www.reddit.com/search.json?q=${q}&sort=new&limit=${limit}`;

  try {
    const body = await fetchText(endpoint, {
      timeoutMs,
      headers: { "User-Agent": "LookaCrawler/1.1 (public research)", Accept: "application/json" },
    });
    const posts = parseRedditJson(JSON.parse(body), query);

    const summaryLines = posts.map(
      (p, i) => `${i + 1}. [r/${p.subreddit}] "${p.title}" (score ${p.score}, ${p.numComments} comments, ${p.intentCategory})`
    );

    return {
      query,
      subreddit,
      totalFound: posts.length,
      posts,
      summaryText: summaryLines.join("\n") || "No relevant posts found.",
    };
  } catch (err: any) {
    return {
      query,
      subreddit,
      totalFound: 0,
      posts: [],
      summaryText: `Reddit search failed: ${err?.message || "error"}`,
    };
  }
}
