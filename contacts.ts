import { JSDOM } from "jsdom";
import { fetchHtml } from "./extractor.js";
import { validateTargetUrl } from "./security.js";

export interface SocialProfiles {
  instagram?: string;
  facebook?: string;
  linkedin?: string;
  twitter?: string;
  youtube?: string;
  github?: string;
  tiktok?: string;
}

export interface ExtractedContacts {
  url: string;
  emails: string[];
  phones: string[];
  whatsapps: string[];
  socials: SocialProfiles;
  contactPagesScanned: string[];
}

export interface ExtractContactsOptions {
  url: string;
  deepScan?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  proxy?: string;
}

// RFC 5322-compliant extraction pattern
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

// Known dummy / placeholder email prefixes & domains
const IGNORED_EMAIL_PATTERNS = [
  /^user@/i,
  /^example@/i,
  /^test@/i,
  /^teste@/i,
  /^email@/i,
  /^contato@dominio\.com/i,
  /@example\.com$/i,
  /@domain\.com$/i,
  /@site\.com$/i,
  /@sentry\.io$/i,
  /@wixpress\.com$/i,
  /@cloudflare\.com$/i,
];

// File extensions mistakenly captured as email domain ends
const INVALID_EMAIL_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "svg", "css", "js", "woff", "woff2", "ttf", "ico"
]);

const PHONE_REGEX = /(?:\+?(\d{1,3}))?[-.\s]?(?:\(?(\d{2,3})\)?)?[-.\s]?(\d{4,5})[-.\s]?(\d{4})\b/g;

/**
 * Extract contact information, social links, and communication endpoints from a target website.
 */
export async function extractContacts(options: ExtractContactsOptions): Promise<ExtractedContacts> {
  const { url, deepScan = true, timeoutMs = 12000, headers, cookies, proxy } = options;
  await validateTargetUrl(url);

  const parsedRoot = new URL(url);
  const emailsSet = new Set<string>();
  const phonesSet = new Set<string>();
  const whatsappsSet = new Set<string>();
  const socials: SocialProfiles = {};
  const scannedPages: string[] = [url];

  // 1. Fetch & scan root HTML
  try {
    const rootHtml = await fetchHtml(url, { timeoutMs, headers, cookies, proxy });
    parseContactsFromHtml(rootHtml, parsedRoot, emailsSet, phonesSet, whatsappsSet, socials);

    // 2. Discover and scan dedicated contact subpages if deepScan is enabled
    if (deepScan) {
      const contactUrls = discoverContactSubpages(rootHtml, parsedRoot);
      const subpagesToVisit = contactUrls.slice(0, 3); // Max 3 subpages

      await Promise.all(
        subpagesToVisit.map(async (subUrl) => {
          try {
            await validateTargetUrl(subUrl);
            const subHtml = await fetchHtml(subUrl, { timeoutMs: 8000, headers, cookies, proxy });
            scannedPages.push(subUrl);
            parseContactsFromHtml(subHtml, parsedRoot, emailsSet, phonesSet, whatsappsSet, socials);
          } catch {
            /* ignore subpage failure */
          }
        })
      );
    }
  } catch (err: any) {
    // If root fails, rethrow
    throw new Error(`Failed to extract contacts from ${url}: ${err.message || String(err)}`);
  }

  return {
    url,
    emails: Array.from(emailsSet).sort(),
    phones: Array.from(phonesSet).sort(),
    whatsapps: Array.from(whatsappsSet).sort(),
    socials,
    contactPagesScanned: scannedPages,
  };
}

/**
 * Parses emails, phone numbers, WhatsApps, and social links from an HTML document string.
 */
function parseContactsFromHtml(
  html: string,
  rootUrl: URL,
  emails: Set<string>,
  phones: Set<string>,
  whatsapps: Set<string>,
  socials: SocialProfiles
): void {
  const dom = new JSDOM(html, { url: rootUrl.toString() });
  const doc = dom.window.document;

  // 1. Extract mailto: links
  for (const a of Array.from(doc.querySelectorAll('a[href^="mailto:"]'))) {
    const raw = a.getAttribute("href") || "";
    const mail = raw.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
    if (isValidEmail(mail)) {
      emails.add(mail);
    }
  }

  // 2. Extract tel: links
  for (const a of Array.from(doc.querySelectorAll('a[href^="tel:"]'))) {
    const raw = a.getAttribute("href") || "";
    const cleanPhone = raw.replace(/^tel:/i, "").trim();
    if (cleanPhone.length >= 8) {
      phones.add(cleanPhone);
    }
  }

  // 3. Extract WhatsApp links
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = (a.getAttribute("href") || "").trim();
    if (
      href.includes("wa.me/") ||
      href.includes("api.whatsapp.com/send") ||
      href.startsWith("whatsapp:")
    ) {
      const parsedNumber = extractWhatsAppNumber(href);
      if (parsedNumber) {
        whatsapps.add(parsedNumber);
      }
    }

    // Social Media Links
    detectSocialLink(href, socials);
  }

  // 4. Text regex scan for emails and phone numbers
  const bodyText = doc.body ? doc.body.textContent || "" : "";

  // Scan emails in text
  const emailMatches = bodyText.match(EMAIL_REGEX) || [];
  for (const email of emailMatches) {
    const lower = email.toLowerCase();
    if (isValidEmail(lower)) {
      emails.add(lower);
    }
  }

  // Scan phones in text
  const phoneMatches = bodyText.match(PHONE_REGEX) || [];
  for (const phone of phoneMatches) {
    const cleaned = phone.trim();
    // Validate minimum digits to eliminate dates or small integers
    const digitsOnly = cleaned.replace(/\D/g, "");
    if (digitsOnly.length >= 8 && digitsOnly.length <= 15) {
      // Exclude common date patterns like 2026 or year stamps
      if (!cleaned.match(/^(19|20)\d{2}$/)) {
        phones.add(cleaned);
      }
    }
  }
}

/**
 * Filter out invalid, dummy, or static-file false positive emails.
 */
function isValidEmail(email: string): boolean {
  if (!email || email.length < 6 || email.length > 100) return false;
  if (!email.includes("@") || !email.includes(".")) return false;

  // Check extension after last dot
  const lastDot = email.lastIndexOf(".");
  const ext = email.slice(lastDot + 1).toLowerCase();
  if (INVALID_EMAIL_EXTENSIONS.has(ext)) return false;

  for (const pattern of IGNORED_EMAIL_PATTERNS) {
    if (pattern.test(email)) return false;
  }

  return true;
}

/**
 * Normalizes WhatsApp phone number from links like wa.me/5511999999999 or api.whatsapp.com.
 */
function extractWhatsAppNumber(urlStr: string): string | null {
  try {
    if (urlStr.includes("wa.me/")) {
      const segment = urlStr.split("wa.me/")[1]?.split("?")[0]?.replace(/\D/g, "");
      return segment && segment.length >= 8 ? segment : null;
    }
    if (urlStr.includes("phone=")) {
      const match = urlStr.match(/phone=([0-9+]+)/);
      if (match && match[1]) {
        const clean = match[1].replace(/\D/g, "");
        return clean.length >= 8 ? clean : null;
      }
    }
  } catch {
    /* ignore parse error */
  }
  return null;
}

/**
 * Detects social profile links from anchor URLs.
 */
function detectSocialLink(href: string, socials: SocialProfiles): void {
  try {
    const lower = href.toLowerCase();

    if (lower.includes("instagram.com/") && !socials.instagram) {
      if (!lower.includes("/p/") && !lower.includes("/stories/") && !lower.includes("/explore/")) {
        socials.instagram = cleanUrl(href);
      }
    } else if (lower.includes("linkedin.com/") && !socials.linkedin) {
      if (lower.includes("/company/") || lower.includes("/in/")) {
        socials.linkedin = cleanUrl(href);
      }
    } else if (lower.includes("facebook.com/") && !socials.facebook) {
      if (!lower.includes("/sharer") && !lower.includes("/share.php")) {
        socials.facebook = cleanUrl(href);
      }
    } else if ((lower.includes("twitter.com/") || lower.includes("x.com/")) && !socials.twitter) {
      if (!lower.includes("/intent/") && !lower.includes("/share")) {
        socials.twitter = cleanUrl(href);
      }
    } else if (lower.includes("youtube.com/") && !socials.youtube) {
      if (lower.includes("/@") || lower.includes("/channel/") || lower.includes("/c/")) {
        socials.youtube = cleanUrl(href);
      }
    } else if (lower.includes("github.com/") && !socials.github) {
      socials.github = cleanUrl(href);
    } else if (lower.includes("tiktok.com/@") && !socials.tiktok) {
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

/**
 * Discovers dedicated contact/about subpages on the same host.
 */
function discoverContactSubpages(html: string, rootUrl: URL): string[] {
  const dom = new JSDOM(html, { url: rootUrl.toString() });
  const anchors = Array.from(dom.window.document.querySelectorAll("a[href]"));
  const contactKeywords = [
    "contato",
    "contact",
    "fale-conosco",
    "faleconosco",
    "sobre",
    "about",
    "quem-somos",
    "equipe",
    "team",
    "trabalhe-conosco",
  ];

  const foundUrls = new Set<string>();

  for (const a of anchors) {
    const href = a.getAttribute("href")?.trim();
    if (!href) continue;

    const text = (a.textContent || "").toLowerCase().trim();
    const hrefLower = href.toLowerCase();

    const matchesKeyword = contactKeywords.some(
      (kw) => hrefLower.includes(kw) || text.includes(kw)
    );

    if (matchesKeyword) {
      try {
        const resolved = new URL(href, rootUrl);
        if (
          resolved.hostname === rootUrl.hostname &&
          (resolved.protocol === "http:" || resolved.protocol === "https:") &&
          resolved.pathname !== rootUrl.pathname
        ) {
          resolved.hash = "";
          resolved.search = "";
          foundUrls.add(resolved.toString());
        }
      } catch {
        /* skip invalid link */
      }
    }
  }

  return Array.from(foundUrls);
}
