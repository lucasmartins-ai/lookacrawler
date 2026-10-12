import { JSDOM } from "jsdom";
import type { CountryCode } from "libphonenumber-js";
import { fetchHtml } from "./extractor.js";
import { validateTargetUrl } from "./security.js";
import { normalizePhone, findPhones, type NormalizedPhone, type PhoneType } from "./quality/phone.js";
import { cleanEmail, findEmails } from "./quality/email.js";
import { extractCnpjs } from "./quality/cnpj.js";

const WHATSAPP_URL_REGEX = /(?<![\w.])(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?(?:[^"'\s<>]*?&(?:amp;)?)?phone=|whatsapp:\/\/send\/?\?phone=)(?:%2B|\+)?(\d[\d-]{8,18}\d)/gi;

export interface SocialProfiles {
  instagram?: string;
  facebook?: string;
  linkedin?: string;
  twitter?: string;
  youtube?: string;
  github?: string;
  tiktok?: string;
}

export interface ContactPhone {
  e164: string;
  /** National format for numbers in the default region, international otherwise. */
  formatted: string;
  type: PhoneType;
  valid: boolean;
  /** "tel" for tel: links, "text" for numbers found in visible text. */
  origin: "tel" | "text";
  /** The same number also appears in a WhatsApp link on the site. */
  whatsapp?: boolean;
  /** First page the number was seen on. */
  url: string;
}

export interface ExtractedContacts {
  url: string;
  emails: string[];
  /** Formatted phones, deduplicated by E.164. */
  phones: string[];
  whatsapps: string[];
  socials: SocialProfiles;
  contactPagesScanned: string[];
  /** Normalized phones with type and origin, same order as `phones`. */
  phoneDetails?: ContactPhone[];
  /** DV-valid CNPJs printed on the site (unmasked), numeric or alphanumeric. */
  cnpjs?: string[];
}

export interface ExtractContactsOptions {
  url: string;
  deepScan?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  proxy?: string;
  /** Already-fetched HTML of `url`; skips the root fetch when provided. */
  html?: string;
  /** Region used to read numbers without a country code. Defaults to "BR". */
  defaultRegion?: CountryCode;
  /** Contact subpages to visit when deepScan is on. Defaults to 3. */
  maxSubpages?: number;
}

/**
 * Everything found on one page. `contactLinks` are same-host subpages worth
 * visiting, best first.
 */
export interface PageContacts {
  emails: string[];
  phones: ContactPhone[];
  whatsapps: string[];
  socials: SocialProfiles;
  cnpjs: string[];
  contactLinks: string[];
}

export interface ParseContactsOptions {
  /** URL of the page being parsed, when it differs from the site root. */
  pageUrl?: string;
  defaultRegion?: CountryCode;
}

/**
 * Extract contact information, social links, and communication endpoints from a target website.
 */
export async function extractContacts(options: ExtractContactsOptions): Promise<ExtractedContacts> {
  const {
    url,
    deepScan = true,
    timeoutMs = 12000,
    headers,
    cookies,
    proxy,
    html,
    defaultRegion = "BR",
    maxSubpages = 3,
  } = options;
  await validateTargetUrl(url);

  const parsedRoot = new URL(url);
  const merged = new ContactMerger(url);

  // 1. Fetch & scan root HTML
  try {
    const rootHtml = html ?? (await fetchHtml(url, { timeoutMs, headers, cookies, proxy }));
    const root = parseContactsFromHtml(rootHtml, parsedRoot, { defaultRegion });
    merged.add(root);

    // 2. Visit the best-ranked contact subpages if deepScan is enabled
    if (deepScan) {
      const subpagesToVisit = root.contactLinks.slice(0, maxSubpages);
      const pages = await Promise.all(
        subpagesToVisit.map(async (subUrl) => {
          try {
            await validateTargetUrl(subUrl);
            const subHtml = await fetchHtml(subUrl, { timeoutMs: 8000, headers, cookies, proxy });
            return { subUrl, found: parseContactsFromHtml(subHtml, parsedRoot, { pageUrl: subUrl, defaultRegion }) };
          } catch {
            return null; /* ignore subpage failure */
          }
        })
      );
      // Merge in ranking order so the result does not depend on response timing.
      for (const page of pages) {
        if (!page) continue;
        merged.scanned.push(page.subUrl);
        merged.add(page.found);
      }
    }
  } catch (err: any) {
    // If root fails, rethrow
    throw new Error(`Failed to extract contacts from ${url}: ${err.message || String(err)}`);
  }

  return merged.result();
}

class ContactMerger {
  readonly scanned: string[];
  private emails = new Set<string>();
  private phones = new Map<string, ContactPhone>();
  private whatsapps = new Set<string>();
  private cnpjs = new Set<string>();
  private socials: SocialProfiles = {};

  constructor(private url: string) {
    this.scanned = [url];
  }

  add(page: PageContacts): void {
    for (const e of page.emails) this.emails.add(e);
    for (const p of page.phones) {
      const existing = this.phones.get(p.e164);
      // A tel: link is stronger evidence than a number read from text.
      if (!existing || (existing.origin === "text" && p.origin === "tel")) this.phones.set(p.e164, p);
    }
    for (const w of page.whatsapps) this.whatsapps.add(w);
    for (const c of page.cnpjs) this.cnpjs.add(c);
    for (const [k, v] of Object.entries(page.socials) as [keyof SocialProfiles, string][]) {
      if (v && !this.socials[k]) this.socials[k] = v;
    }
  }

  result(): ExtractedContacts {
    const details = Array.from(this.phones.values()).sort((a, b) => a.formatted.localeCompare(b.formatted));
    for (const d of details) {
      if (this.whatsapps.has(d.e164.slice(1))) d.whatsapp = true;
    }
    return {
      url: this.url,
      emails: Array.from(this.emails).sort(),
      phones: details.map((d) => d.formatted),
      whatsapps: Array.from(this.whatsapps).sort(),
      socials: this.socials,
      contactPagesScanned: this.scanned,
      phoneDetails: details,
      cnpjs: Array.from(this.cnpjs),
    };
  }
}

/**
 * Decode a Cloudflare-obfuscated email from `/cdn-cgi/l/email-protection#<hex>`.
 *
 * The first byte is the XOR key and the rest is the address, one byte each.
 * Millions of sites protect their contact address this way, so a plain text
 * scan finds "[email protected]" and returns nothing at all.
 */
export function decodeCloudflareEmail(hex: string): string | null {
  const clean = hex.trim();
  if (clean.length < 4 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) {
    return null;
  }
  const key = parseInt(clean.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16) ^ key);
  }
  return out.includes("@") ? out : null;
}

/**
 * Parse contacts from an HTML string. Builds one JSDOM; prefer
 * parseContactsFromDocument when the caller already has a document.
 */
export function parseContactsFromHtml(html: string, rootUrl: URL | string, options: ParseContactsOptions = {}): PageContacts {
  const dom = new JSDOM(html, { url: options.pageUrl || rootUrl.toString() });
  return parseContactsFromDocument(dom.window.document, rootUrl, options);
}

/**
 * Parse emails, phone numbers, WhatsApps, social links, CNPJs and contact
 * subpage links from a ready DOM in a single pass. The document is not
 * modified, so the caller can keep using it.
 */
export function parseContactsFromDocument(
  doc: Document,
  rootUrl: URL | string,
  options: ParseContactsOptions = {}
): PageContacts {
  const root = typeof rootUrl === "string" ? new URL(rootUrl) : rootUrl;
  const pageUrl = options.pageUrl || root.toString();
  const defaultRegion = options.defaultRegion || "BR";

  const emails = new Set<string>();
  const phones = new Map<string, ContactPhone>();
  const whatsapps = new Set<string>();
  const socials: SocialProfiles = {};

  const addPhone = (parsed: NormalizedPhone | null, origin: "tel" | "text") => {
    if (!parsed || phones.has(parsed.e164)) return;
    phones.set(parsed.e164, {
      e164: parsed.e164,
      formatted: parsed.country === defaultRegion ? parsed.national : parsed.international,
      type: parsed.type,
      valid: parsed.valid,
      origin,
      url: pageUrl,
    });
  };

  // 1. Email-protection, mailto:, tel:, WhatsApp, social and contact-subpage
  //    links in one walk over anchors (one selector query instead of four).
  const ranked: { url: string; rank: number; order: number }[] = [];
  const seenLinks = new Set<string>();
  const anchors = Array.from(doc.querySelectorAll("a[href]"));
  anchors.forEach((a, order) => {
    const href = (a.getAttribute("href") || "").trim();
    const scheme = href.slice(0, 7).toLowerCase();
    // Cloudflare email protection: the address never appears as plaintext.
    if (href.includes("/cdn-cgi/l/email-protection")) {
      const decoded = cleanEmail(decodeCloudflareEmail(href.split("#")[1] || ""));
      if (decoded) emails.add(decoded);
    } else if (scheme === "mailto:") {
      const mail = cleanEmail(href);
      if (mail) emails.add(mail);
    } else if (scheme.startsWith("tel:")) {
      // The site owner marked this as a phone, so a number that is possible
      // but fails strict validation is still kept.
      addPhone(normalizePhone(href, { defaultRegion, context: "tel" }), "tel");
    }
    if (
      href.includes("wa.me/") ||
      href.includes("api.whatsapp.com/send") ||
      href.startsWith("whatsapp:")
    ) {
      const parsedNumber = extractWhatsAppNumber(href, defaultRegion);
      if (parsedNumber) whatsapps.add(parsedNumber);
    }

    detectSocialLink(href, socials);

    const rank = contactLinkRank(href, a.textContent || "", root);
    if (rank !== null) {
      try {
        const resolved = new URL(href, pageUrl);
        resolved.hash = "";
        resolved.search = "";
        const key = resolved.toString();
        if (!seenLinks.has(key)) {
          seenLinks.add(key);
          ranked.push({ url: key, rank, order });
        }
      } catch {
        /* skip invalid link */
      }
    }
  });

  // 3b. WhatsApp links outside anchors: chat widgets keep them in <script>,
  //     escaped JSON (`https:\/\/`) or data-* attributes, which is how most
  //     Brazilian sites expose the number.
  const rawHtml = doc.documentElement.outerHTML;
  // Cheap prefilter: the lookbehind regex over the whole serialized page is the
  // costliest scan here, and most pages have no WhatsApp link at all.
  const waMatches = /wa\.me|whatsapp/i.test(rawHtml) ? rawHtml.replace(/\\\//g, "/").matchAll(WHATSAPP_URL_REGEX) : [];
  for (const m of waMatches) {
    const digits = m[1].replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 15) whatsapps.add(digits);
  }

  // 4. Visible text scan for emails (incl. "[at]" spellings), phones and CNPJs
  const bodyText = visibleText(doc);
  for (const email of findEmails(bodyText)) emails.add(email);
  for (const phone of findPhones(bodyText, { defaultRegion })) addPhone(phone, "text");
  const cnpjs = extractCnpjs(bodyText);

  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return {
    emails: Array.from(emails),
    phones: Array.from(phones.values()),
    whatsapps: Array.from(whatsapps),
    socials,
    cnpjs,
    contactLinks: ranked.map((r) => r.url),
  };
}

/**
 * Text of the document body without script/style content, with a space between
 * text nodes. `textContent` glues adjacent elements together, so
 * `<span>(62) 99999-9999</span><span>contato@x.com</span>` would read as a
 * single "email" starting with the phone digits.
 */
const HIDDEN_TAGS = new Set(["script", "style", "noscript", "template"]);

function visibleText(doc: Document): string {
  if (!doc.body) return "";
  // Skip whole script/style subtrees instead of calling closest() per text node:
  // jsdom's selector engine made that half the cost of parsing a large page.
  const parts: string[] = [];
  const walk = (node: Node): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        if (child.nodeValue) parts.push(child.nodeValue);
      } else if (child.nodeType === 1 && !HIDDEN_TAGS.has((child as Element).localName)) {
        walk(child);
      }
    }
  };
  walk(doc.body);
  return parts.join(" ");
}

/**
 * Normalizes WhatsApp phone number from links like wa.me/5511999999999 or
 * api.whatsapp.com, as international digits without "+".
 */
function extractWhatsAppNumber(urlStr: string, defaultRegion: CountryCode): string | null {
  let digits: string | undefined;
  if (urlStr.includes("wa.me/")) {
    digits = urlStr.split("wa.me/")[1]?.split(/[?#/]/)[0]?.replace(/\D/g, "");
  } else {
    digits = urlStr.match(/phone=([0-9+%]+)/)?.[1]?.replace(/%2B/gi, "").replace(/\D/g, "");
  }
  if (!digits || digits.length < 8) return null;
  const parsed = normalizePhone(digits, { defaultRegion, context: "whatsapp" });
  return parsed?.valid ? parsed.e164.slice(1) : digits;
}

/**
 * Detects social profile links from anchor URLs.
 */
function detectSocialLink(href: string, socials: SocialProfiles): void {
  try {
    // Match on the hostname: a substring test for "x.com/" also hits
    // dropbox.com, fedex.com, box.com, ...
    let host: string;
    try {
      host = new URL(href).hostname.toLowerCase();
    } catch {
      return;
    }
    const isHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    const lower = href.toLowerCase();

    if (isHost("instagram.com") && !socials.instagram) {
      if (!lower.includes("/p/") && !lower.includes("/stories/") && !lower.includes("/explore/")) {
        socials.instagram = cleanUrl(href);
      }
    } else if (isHost("linkedin.com") && !socials.linkedin) {
      if (lower.includes("/company/") || lower.includes("/in/")) {
        socials.linkedin = cleanUrl(href);
      }
    } else if (isHost("facebook.com") && !socials.facebook) {
      if (!lower.includes("/sharer") && !lower.includes("/share.php")) {
        socials.facebook = cleanUrl(href);
      }
    } else if ((isHost("twitter.com") || isHost("x.com")) && !socials.twitter) {
      if (!lower.includes("/intent/") && !lower.includes("/share")) {
        socials.twitter = cleanUrl(href);
      }
    } else if (isHost("youtube.com") && !socials.youtube) {
      if (lower.includes("/@") || lower.includes("/channel/") || lower.includes("/c/")) {
        socials.youtube = cleanUrl(href);
      }
    } else if (isHost("github.com") && !socials.github) {
      socials.github = cleanUrl(href);
    } else if (isHost("tiktok.com") && lower.includes("/@") && !socials.tiktok) {
      socials.tiktok = cleanUrl(href);
    }
  } catch {
    /* skip invalid URL parsing */
  }
}

function cleanUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw.split("?")[0].split("#")[0];
  }
}

// Contact subpage keywords by priority (lower is better). Multi-word entries
// use "-" and are matched as whole words against path segments and link text.
const CONTACT_KEYWORDS: [string, number][] = [
  ["contato", 0], ["contatos", 0], ["contact", 0], ["contacts", 0], ["contact-us", 0], ["contactus", 0],
  ["fale-conosco", 0], ["faleconosco", 0], ["atendimento", 0],
  ["sobre", 1], ["sobre-nos", 1], ["about", 1], ["about-us", 1], ["quem-somos", 1], ["quemsomos", 1],
  ["a-empresa", 1], ["institucional", 1],
  ["equipe", 2], ["nossa-equipe", 2], ["team", 2], ["our-team", 2], ["corpo-clinico", 2],
  ["trabalhe-conosco", 3],
];

const PADDED_KEYWORDS = CONTACT_KEYWORDS.map(([kw, rank]) => [`-${kw}-`, rank] as const);

const NON_PAGE_EXTENSIONS = /\.(?:pdf|jpe?g|png|gif|webp|svg|zip|rar|docx?|xlsx?|mp4|mp3)$/i;

/** Lowercase, strip accents and turn every non-alphanumeric run into "-". */
function wordKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

function keywordRank(key: string): number | null {
  const padded = `-${key}-`;
  let best: number | null = null;
  for (const [kw, rank] of PADDED_KEYWORDS) {
    if ((best === null || rank < best) && padded.includes(kw)) best = rank;
  }
  return best;
}

/**
 * Priority of a link as a contact subpage, or null when it is not one.
 * Matches whole path segments or whole words in the link text, never
 * substrings ("team" must not match "steam", "sobre" not "Sobremesas").
 */
function contactLinkRank(href: string, text: string, root: URL): number | null {
  if (!href || href.startsWith("#") || /^(?:mailto|tel|javascript|whatsapp):/i.test(href)) return null;
  let resolved: URL;
  try {
    resolved = new URL(href, root);
  } catch {
    return null;
  }
  if (resolved.hostname !== root.hostname) return null;
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  const path = resolved.pathname.replace(/\/+$/, "");
  if (path === root.pathname.replace(/\/+$/, "") || NON_PAGE_EXTENSIONS.test(path)) return null;

  let best: number | null = null;
  for (const segment of path.split("/")) {
    if (!segment) continue;
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      /* keep raw */
    }
    const rank = keywordRank(wordKey(decoded.replace(/\.(?:html?|php|aspx?)$/i, "")));
    if (rank !== null && (best === null || rank < best)) best = rank;
  }

  const label = text.trim();
  if (label && label.length <= 60) {
    const rank = keywordRank(wordKey(label));
    if (rank !== null && (best === null || rank < best)) best = rank;
  }
  return best;
}
