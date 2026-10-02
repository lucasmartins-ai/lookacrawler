import { extractFast, extractDeep, type LinkFormat, type ImageMode } from "./extractor.js";
import { getCachedPage, setCachedPage, buildCacheKey } from "./cache.js";
import { validateTargetUrl } from "./security.js";
import type { GoogleMapsLead } from "./maps-bridge.js";

export interface EnrichedLeadResult {
  title: string;
  category?: string;
  address?: string;
  phone?: string;
  whatsapp?: string;
  website?: string;
  rating?: number;
  reviews?: number;
  latitude?: number;
  longitude?: number;

  // Enriched fields
  emails: string[];
  socialLinks: {
    instagram?: string;
    linkedin?: string;
    facebook?: string;
    youtube?: string;
    twitter?: string;
  };
  additionalPhones: string[];
  decisionMakers: string[];
  markdownSummary: string;
  estimatedTokens: number;
  enrichedFromUrl?: string;
  sourcePagesCrawled: string[];
  enrichmentSuccess: boolean;
  error?: string;
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const INTL_PHONE_REGEX = /(?:\+?[0-9]{1,4}[\s.-]?)?(?:\([0-9]{2,4}\)[\s.-]?)?[0-9]{3,5}[\s.-]?[0-9]{3,4}/g;

/**
 * Filter out false-positive, CDN, or image placeholder emails.
 */
function cleanEmails(rawEmails: string[]): string[] {
  const ignoredDomains = [
    "sentry.io",
    "wixpress.com",
    "example.com",
    "domain.com",
    "email.com",
    "schema.org",
    "wordpress.org",
    "gravatar.com",
  ];
  const ignoredExts = [".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".pdf"];

  const set = new Set<string>();
  for (const e of rawEmails) {
    const lower = e.toLowerCase().trim();
    if (ignoredExts.some((ext) => lower.endsWith(ext))) continue;
    const parts = lower.split("@");
    if (parts.length !== 2) continue;
    const domain = parts[1];
    if (ignoredDomains.some((d) => domain.includes(d))) continue;
    set.add(lower);
  }
  return Array.from(set);
}

/**
 * Deeply enrich a company or Google Maps lead using LookaCrawler's token-optimized engine.
 */
export async function deepEnrichLead(
  lead: Partial<GoogleMapsLead> & { title: string; web_site?: string },
  options: {
    mode?: "fast" | "deep";
    crawlContactPages?: boolean;
    linkFormat?: LinkFormat;
    imageMode?: ImageMode;
  } = {}
): Promise<EnrichedLeadResult> {
  const mode = options.mode || "fast";
  const linkFormat = options.linkFormat || "references";
  const imageMode = options.imageMode || "alt_only";

  const result: EnrichedLeadResult = {
    title: lead.title,
    category: lead.category,
    address: lead.address,
    phone: lead.phone,
    whatsapp: lead.whatsapp_link,
    website: lead.web_site,
    rating: lead.review_rating,
    reviews: lead.review_count,
    latitude: lead.latitude,
    longitude: lead.longitude,
    emails: lead.emails ? [...lead.emails] : [],
    socialLinks: {},
    additionalPhones: [],
    decisionMakers: [],
    markdownSummary: "",
    estimatedTokens: 0,
    sourcePagesCrawled: [],
    enrichmentSuccess: false,
  };

  if (!lead.web_site || !lead.web_site.startsWith("http")) {
    result.error = "Lead não possui website válido para enriquecimento.";
    return result;
  }

  try {
    await validateTargetUrl(lead.web_site);
  } catch (secErr: any) {
    result.error = `Website bloqueado por política de segurança: ${secErr?.message}`;
    return result;
  }

  try {
    // 1. Crawl home page with cache
    const cacheKey = buildCacheKey({
      url: lead.web_site,
      mode,
      linkFormat,
      imageMode,
    });
    let homeMarkdown = getCachedPage(cacheKey);

    if (!homeMarkdown) {
      if (mode === "deep") {
        homeMarkdown = await extractDeep({
          url: lead.web_site,
          linkFormat,
          imageMode,
        });
      } else {
        homeMarkdown = await extractFast({
          url: lead.web_site,
          linkFormat,
          imageMode,
        });
      }
      setCachedPage(cacheKey, homeMarkdown, 86400 * 7); // Cache for 7 days
    }

    result.sourcePagesCrawled.push(lead.web_site);
    result.enrichedFromUrl = lead.web_site;

    // 2. Extract emails from markdown
    const foundEmails = homeMarkdown.match(EMAIL_REGEX) || [];
    const cleaned = cleanEmails(foundEmails);
    for (const em of cleaned) {
      if (!result.emails.includes(em)) result.emails.push(em);
    }

    // 3. Extract social links
    const socialMatches = homeMarkdown.match(/https?:\/\/(?:www\.)?(instagram|linkedin|facebook|youtube|twitter|x)\.com\/[a-zA-Z0-9._-]+/gi) || [];
    for (const sm of socialMatches) {
      const lower = sm.toLowerCase();
      if (lower.includes("instagram.com") && !result.socialLinks.instagram) {
        result.socialLinks.instagram = sm;
      } else if (lower.includes("linkedin.com") && !result.socialLinks.linkedin) {
        result.socialLinks.linkedin = sm;
      } else if (lower.includes("facebook.com") && !result.socialLinks.facebook) {
        result.socialLinks.facebook = sm;
      } else if (lower.includes("youtube.com") && !result.socialLinks.youtube) {
        result.socialLinks.youtube = sm;
      } else if ((lower.includes("twitter.com") || lower.includes("x.com")) && !result.socialLinks.twitter) {
        result.socialLinks.twitter = sm;
      }
    }

    // 4. Extract possible additional phones
    const foundPhones = homeMarkdown.match(INTL_PHONE_REGEX) || [];
    for (const rawP of foundPhones) {
      const clean = rawP.trim();
      const digits = clean.replace(/[^0-9]/g, "");
      if (digits.length >= 8 && digits.length <= 15) {
        if (!result.additionalPhones.includes(clean) && clean !== result.phone) {
          result.additionalPhones.push(clean);
        }
      }
    }

    // 5. If no emails found and crawlContactPages enabled, attempt to fetch dedicated contact page
    if (options.crawlContactPages !== false && result.emails.length === 0) {
      const contactUrlMatch = homeMarkdown.match(/https?:\/\/[^\s\)\"\'\]]+(?:contact|contato|fale-conosco|about|quem-somos)[^\s\)\"\'\]]*/i);
      if (contactUrlMatch && contactUrlMatch[0] !== lead.web_site) {
        const contactUrl = contactUrlMatch[0];
        try {
          await validateTargetUrl(contactUrl);
          const contactMd = await extractFast({
            url: contactUrl,
            linkFormat,
            imageMode,
          });
          result.sourcePagesCrawled.push(contactUrl);
          const contactEmails = cleanEmails(contactMd.match(EMAIL_REGEX) || []);
          for (const em of contactEmails) {
            if (!result.emails.includes(em)) result.emails.push(em);
          }
        } catch {
          /* non-critical contact page crawl failure */
        }
      }
    }

    // 6. Extract possible decision makers / doctors / owners
    const personRegex = /(?:Dr\.|Dra\.|Diretor|Fundador|Sócio|CEO|Proprietário|Cirurgião|Owner|Founder|Director)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g;
    let match;
    while ((match = personRegex.exec(homeMarkdown)) !== null) {
      if (match[1] && !result.decisionMakers.includes(match[1])) {
        result.decisionMakers.push(match[1].trim());
      }
    }

    // 7. Build ultra-compact LLM summary (< 300 tokens)
    const summaryLines: string[] = [
      `### ${result.title}`,
      `- **Categoria/Nicho:** ${result.category || "Não informado"}`,
      `- **Localização:** ${result.address || "Não informada"}`,
      result.phone ? `- **Telefone Comercial:** ${result.phone}` : "",
      result.whatsapp ? `- **WhatsApp:** ${result.whatsapp}` : "",
      result.emails.length > 0 ? `- **E-mails Encontrados:** ${result.emails.join(", ")}` : "",
      result.decisionMakers.length > 0 ? `- **Responsáveis/Corpo Técnico:** ${result.decisionMakers.join(", ")}` : "",
      result.socialLinks.instagram ? `- **Instagram:** ${result.socialLinks.instagram}` : "",
      result.socialLinks.linkedin ? `- **LinkedIn:** ${result.socialLinks.linkedin}` : "",
      result.socialLinks.twitter ? `- **Twitter/X:** ${result.socialLinks.twitter}` : "",
      `\n**Resumo do Conteúdo Web:**`,
      homeMarkdown.slice(0, 1000).replace(/\n{2,}/g, "\n").trim(),
    ].filter(Boolean);

    result.markdownSummary = summaryLines.join("\n");
    result.estimatedTokens = Math.ceil(result.markdownSummary.length / 4);
    result.enrichmentSuccess = true;
  } catch (err: any) {
    result.error = `Erro ao enriquecer lead via LookaCrawler: ${err?.message}`;
  }

  return result;
}
