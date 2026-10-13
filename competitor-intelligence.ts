/**
 * Site audit + local competitor intelligence. Deterministic: no paid API, no
 * LLM. Everything is read from the page HTML (JSDOM) and from Google Maps
 * listings; each competitor site is fetched once through fetchRawHtml, so the
 * SSRF / egress guard and the response cap apply.
 */

import { JSDOM } from "jsdom";
import { fetchRawHtml, processHtmlToMarkdown } from "./extractor.js";
import { discoverLocalLeads, type GoogleMapsLead } from "./maps-bridge.js";
import { parseContactsFromDocument } from "./contacts.js";

export type Locale = "pt" | "en";

export interface SiteAudit {
  companyName: string;
  websiteUrl: string;
  domain: string;
  meta: {
    title?: string;
    description?: string;
    ogTitle?: string;
    ogDescription?: string;
    h1s: string[];
    h2s: string[];
  };
  conversion: {
    hasWhatsApp: boolean;
    whatsappLink?: string;
    hasPhone: boolean;
    phone?: string;
    hasEmail: boolean;
    email?: string;
    hasOnlineBooking: boolean;
    bookingUrl?: string;
    hasContactForm: boolean;
  };
  services: string[];
  valueProposition: string;
  /** 0-100, from the checklist below. */
  seoScore: number;
  seoIssues: string[];
  /** 0-100 from observed signals (https, tracking, structured data, booking, WhatsApp...). */
  digitalMaturity: number;
  summaryMarkdown: string;
}

export interface CompetitorProfile {
  name: string;
  domain?: string;
  websiteUrl?: string;
  address?: string;
  googleRating?: number;
  reviewCount?: number;
  category?: string;
  whatsappLink?: string;
  phone?: string;
  targetedKeywords: string[];
  strengths: string[];
  weaknesses: string[];
  hasOnlineBooking: boolean;
  hasWhatsApp: boolean;
  /** False when the site could not be fetched or the lead has none. */
  siteReviewed: boolean;
}

export interface CompetitiveAnalysis {
  audit: SiteAudit;
  niche: string;
  location: string;
  locale: Locale;
  competitors: CompetitorProfile[];
  marketGaps: {
    keywordOpportunities: string[];
    serviceOpportunities: string[];
    conversionGaps: string[];
    positioningAdvantage: string;
  };
  durationMs: number;
}

/** Hostname without "www."; a slug-based surrogate when there is no usable website. */
export function extractDomain(website?: string, fallbackTitle = "lead"): string {
  if (website) {
    try {
      const host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, "");
      if (host.includes(".")) return host;
    } catch {}
  }
  const slug = fallbackTitle.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "lead"}.surrogate`;
}

const BOOKING = /agendamento|agendar|agende|marcar (consulta|hor[aá]rio)|reserv(ar|e)|book(ing)?\b|schedule|appointment|calendly|doctoralia/i;
const SERVICES_HEADING = /servi[cç]os|services|tratamentos|especialidades|solu[cç][oõ]es|produtos|products|what we (do|offer)|o que fazemos/i;
const TRACKING = /googletagmanager\.com|google-analytics\.com|gtag\(|connect\.facebook\.net|fbq\(|plausible\.io|hotjar\.com|clarity\.ms/i;

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() || "";
const meta = (doc: Document, sel: string) => doc.querySelector(sel)?.getAttribute("content")?.trim() || undefined;

/** Audit one page: SEO checklist, conversion channels, services, digital maturity. */
export function auditHtml(html: string, url: string, companyName?: string): SiteAudit {
  const doc = new JSDOM(html, { url }).window.document;
  const domain = extractDomain(url, companyName);

  const title = text(doc.querySelector("title")) || undefined;
  const description = meta(doc, 'meta[name="description"]');
  const ogTitle = meta(doc, 'meta[property="og:title"]');
  const ogDescription = meta(doc, 'meta[property="og:description"]');
  const uniq = (sel: string, max: number) => [...new Set(Array.from(doc.querySelectorAll(sel), (e) => text(e).slice(0, 120)).filter(Boolean))].slice(0, max);
  const h1s = uniq("h1", 5);
  const h2s = uniq("h2", 8);

  // Contacts come from the same parser `contacts`/`enrich` use (phone validation, wa.me, tel:).
  const contacts = parseContactsFromDocument(doc, url);
  const markdown = processHtmlToMarkdown(html, { url, linkFormat: "references", imageMode: "alt_only" });

  let bookingUrl: string | undefined;
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    if (BOOKING.test(a.getAttribute("href") || "") || BOOKING.test(text(a))) {
      bookingUrl = a.getAttribute("href") || undefined;
      break;
    }
  }
  const hasOnlineBooking = Boolean(bookingUrl) || BOOKING.test(markdown);
  const hasContactForm = doc.querySelector("form") !== null;
  const whatsappLink = contacts.whatsapps[0];

  // Services: list items under a "services"-like heading, plus .service blocks.
  const services = new Set<string>();
  for (const h of Array.from(doc.querySelectorAll("h2, h3"))) {
    if (!SERVICES_HEADING.test(text(h))) continue;
    let sib = h.nextElementSibling;
    for (let i = 0; sib && i < 3 && !/^H[1-3]$/.test(sib.tagName); i++, sib = sib.nextElementSibling) {
      for (const li of Array.from(sib.matches("li") ? [sib] : sib.querySelectorAll("li, h3, h4"))) {
        const t = text(li);
        if (t.length > 3 && t.length < 70) services.add(t);
      }
    }
  }
  for (const el of Array.from(doc.querySelectorAll(".service, .servico, [class*='service-']"))) {
    const t = text(el.querySelector("h2, h3, h4") || el);
    if (t.length > 3 && t.length < 70) services.add(t);
  }

  // SEO checklist: 100 points, each failed check is reported.
  const issues: string[] = [];
  let seo = 0;
  const check = (ok: boolean, pts: number, issue: string) => (ok ? (seo += pts) : issues.push(issue));
  check(!!title, 10, "missing <title>");
  check(!title || (title.length >= 20 && title.length <= 65), 5, `title length ${title?.length} (aim for 20-65)`);
  check(!!description, 10, "missing meta description");
  check(!description || (description.length >= 70 && description.length <= 165), 5, `meta description length ${description?.length} (aim for 70-165)`);
  check(h1s.length === 1, 10, h1s.length === 0 ? "missing <h1>" : `${h1s.length} <h1> tags (use one)`);
  check(h2s.length > 0, 5, "no <h2> headings");
  check(!!(ogTitle || ogDescription), 10, "missing Open Graph tags");
  check(!!doc.querySelector('link[rel="canonical"]'), 5, "missing canonical link");
  check(!!doc.documentElement.getAttribute("lang"), 5, "missing <html lang>");
  check(!!doc.querySelector('meta[name="viewport"]'), 10, "missing viewport meta (not mobile-ready)");
  check(doc.querySelector('script[type="application/ld+json"]') !== null, 10, "no JSON-LD structured data");
  const imgs = Array.from(doc.querySelectorAll("img"));
  check(imgs.length === 0 || imgs.filter((i) => i.getAttribute("alt")?.trim()).length / imgs.length >= 0.8, 5, "more than 20% of images lack alt text");
  check(url.startsWith("https://"), 10, "not served over https");

  const signals = [
    url.startsWith("https://"),
    !!doc.querySelector('meta[name="viewport"]'),
    TRACKING.test(html),
    doc.querySelector('script[type="application/ld+json"]') !== null,
    hasOnlineBooking,
    contacts.whatsapps.length > 0,
    hasContactForm,
    !!(ogTitle || ogDescription),
  ];
  const digitalMaturity = Math.round((signals.filter(Boolean).length / signals.length) * 100);

  const name = companyName || title?.split(/\s[-|–—]\s|\|/)[0]?.trim() || domain;
  return {
    companyName: name,
    websiteUrl: url,
    domain,
    meta: { title, description, ogTitle, ogDescription, h1s, h2s },
    conversion: {
      hasWhatsApp: contacts.whatsapps.length > 0,
      whatsappLink,
      hasPhone: contacts.phones.length > 0,
      phone: contacts.phones[0]?.formatted,
      hasEmail: contacts.emails.length > 0,
      email: contacts.emails[0],
      hasOnlineBooking,
      bookingUrl,
      hasContactForm,
    },
    services: [...services].slice(0, 10),
    valueProposition: h1s[0] || description || "",
    seoScore: seo,
    seoIssues: issues,
    digitalMaturity,
    summaryMarkdown: markdown,
  };
}

/** Fetch a site and audit its home page. */
export async function auditCompanyWebsite(
  websiteUrl: string,
  options: { companyName?: string; mode?: "fast" | "deep" } = {}
): Promise<SiteAudit> {
  const html = await fetchRawHtml(websiteUrl, options.mode ?? "fast");
  return auditHtml(html, websiteUrl, options.companyName);
}

/** Maps listings for `niche location`, minus the client's own domain. */
export async function discoverCompetitors(
  niche: string,
  location: string,
  clientDomain?: string,
  options: { limit?: number } = {}
): Promise<GoogleMapsLead[]> {
  const limit = options.limit ?? 5;
  const res = await discoverLocalLeads(`${niche} ${location}`.trim(), { limit: limit + 2 });
  return res.data.filter((l) => !clientDomain || !l.web_site || extractDomain(l.web_site, l.title) !== clientDomain).slice(0, limit);
}

const STR = {
  pt: {
    strongRep: (r: number, n: number) => `Boa reputação no Google (${r}★, ${n} avaliações)`,
    weakRep: (r: number) => `Avaliação abaixo de 4,5 no Google (${r}★)`,
    booking: "Tem agendamento online no site",
    noBooking: "Sem agendamento online no site",
    noWhatsApp: "Sem WhatsApp visível",
    whatsApp: "Oferece WhatsApp como canal direto",
    noSite: "Sem site próprio (só a ficha do Google)",
    siteDown: "Site fora do ar ou bloqueado na varredura",
    established: "Presença local estabelecida",
    undifferentiated: "Pouca diferenciação visível na proposta de valor",
    kw: (n: string, l: string) => [`${n} em ${l}`, `melhor ${n} ${l}`, `preço ${n} ${l}`, `${n} perto de mim`],
    kwOpp: (n: string, l: string) => [`${n} em ${l} agendamento`, `${n} ${l} atendimento rápido`, `${n} ${l} orçamento`, `${n} ${l} avaliações`],
    gapBooking: (k: number, t: number) => `${k} de ${t} concorrentes sem agendamento online`,
    gapWhatsApp: (k: number, t: number) => `${k} de ${t} concorrentes sem WhatsApp visível`,
    gapNone: "Os concorrentes cobrem o básico; a diferença está na velocidade de resposta",
    gapUnknown: "não foi possível avaliar os sites dos concorrentes nesta varredura",
    advHas: (c: string) => `${c} já tem agendamento online; destaque isso contra concorrentes que dependem de telefone.`,
    advNone: "Agendamento online (ou por WhatsApp) é a vitória mais rápida contra concorrentes sem ele.",
    serviceFallback: (n: string) => `Principais serviços de ${n}`,
  },
  en: {
    strongRep: (r: number, n: number) => `Strong Google reputation (${r}★, ${n} reviews)`,
    weakRep: (r: number) => `Google rating below 4.5 (${r}★)`,
    booking: "Online booking on the site",
    noBooking: "No online booking on the site",
    noWhatsApp: "No visible WhatsApp",
    whatsApp: "Offers WhatsApp as a direct channel",
    noSite: "No own website (Google listing only)",
    siteDown: "Site unavailable or blocked during the scan",
    established: "Established local presence",
    undifferentiated: "Little visible differentiation in the value proposition",
    kw: (n: string, l: string) => [`${n} in ${l}`, `best ${n} ${l}`, `${n} ${l} price`, `${n} near me`],
    kwOpp: (n: string, l: string) => [`${n} ${l} book online`, `${n} ${l} same day`, `${n} ${l} quote`, `${n} ${l} reviews`],
    gapBooking: (k: number, t: number) => `${k} of ${t} competitors have no online booking`,
    gapWhatsApp: (k: number, t: number) => `${k} of ${t} competitors have no visible WhatsApp`,
    gapNone: "Competitors cover the basics; the gap is response speed",
    gapUnknown: "their websites could not be reviewed in this scan",
    advHas: (c: string) => `${c} already has online booking; lead with it against competitors that rely on phone calls.`,
    advNone: "Online (or WhatsApp) booking is the fastest win against competitors without it.",
    serviceFallback: (n: string) => `Core ${n} services`,
  },
};

async function reviewCompetitor(lead: GoogleMapsLead, niche: string, location: string, locale: Locale): Promise<CompetitorProfile> {
  const t = STR[locale];
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  let hasOnlineBooking = false;
  let hasWhatsApp = !!lead.whatsapp_link && lead.whatsapp_source === "google";
  let siteReviewed = false;
  const keywords: string[] = [];

  const rating = lead.review_rating;
  if (rating && rating >= 4.7 && (lead.review_count || 0) > 30) strengths.push(t.strongRep(rating, lead.review_count!));
  else if (rating && rating < 4.5) weaknesses.push(t.weakRep(rating));

  if (lead.web_site?.startsWith("http")) {
    try {
      const a = auditHtml(await fetchRawHtml(lead.web_site, "fast", { maxRetries: 1, timeoutMs: 10_000 }), lead.web_site, lead.title);
      siteReviewed = true;
      hasOnlineBooking = a.conversion.hasOnlineBooking;
      hasWhatsApp ||= a.conversion.hasWhatsApp;
      if (a.meta.title) keywords.push(a.meta.title.slice(0, 50));
      if (a.meta.h1s[0] && a.meta.h1s[0] !== a.meta.title) keywords.push(a.meta.h1s[0].slice(0, 50));
      (hasOnlineBooking ? strengths : weaknesses).push(hasOnlineBooking ? t.booking : t.noBooking);
      if (!hasWhatsApp) weaknesses.push(t.noWhatsApp);
    } catch {
      weaknesses.push(t.siteDown);
    }
  } else {
    weaknesses.push(t.noSite);
  }
  if (hasWhatsApp) strengths.push(t.whatsApp);

  return {
    name: lead.title,
    domain: lead.web_site ? extractDomain(lead.web_site, lead.title) : undefined,
    websiteUrl: lead.web_site,
    address: lead.address,
    googleRating: lead.review_rating,
    reviewCount: lead.review_count,
    category: lead.category,
    whatsappLink: lead.whatsapp_link,
    phone: lead.phone,
    targetedKeywords: [...new Set([...keywords, ...t.kw(niche, location)])].slice(0, 5),
    strengths: strengths.length ? strengths : [t.established],
    weaknesses: weaknesses.length ? weaknesses : [t.undifferentiated],
    hasOnlineBooking,
    hasWhatsApp,
    siteReviewed,
  };
}

/** Review competitors (3 sites at a time) and derive the market gaps. */
export async function analyzeCompetitors(
  audit: SiteAudit,
  niche: string,
  location: string,
  options: { maxCompetitors?: number; locale?: Locale; competitors?: GoogleMapsLead[] } = {}
): Promise<CompetitiveAnalysis> {
  const start = Date.now();
  const locale = options.locale ?? "pt";
  const t = STR[locale];
  const leads = options.competitors ?? (await discoverCompetitors(niche, location, audit.domain, { limit: options.maxCompetitors ?? 3 }));

  const competitors: CompetitorProfile[] = new Array(leads.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, leads.length) }, async () => {
      while (next < leads.length) {
        const i = next++;
        competitors[i] = await reviewCompetitor(leads[i], niche, location, locale);
      }
    })
  );

  // A site we could not fetch is "unknown", not a gap: count only competitors we could judge.
  const judged = competitors.filter((c) => c.siteReviewed || !c.websiteUrl);
  const total = judged.length;
  const noBooking = judged.filter((c) => !c.hasOnlineBooking).length;
  const noWhatsApp = judged.filter((c) => !c.hasWhatsApp).length;
  const conversionGaps = [
    ...(noBooking ? [t.gapBooking(noBooking, total)] : []),
    ...(noWhatsApp ? [t.gapWhatsApp(noWhatsApp, total)] : []),
  ];

  return {
    audit,
    niche,
    location,
    locale,
    competitors,
    marketGaps: {
      keywordOpportunities: t.kwOpp(niche, location),
      serviceOpportunities: audit.services.length ? audit.services.slice(0, 4) : [t.serviceFallback(niche)],
      conversionGaps: conversionGaps.length ? conversionGaps : [total ? t.gapNone : t.gapUnknown],
      positioningAdvantage: audit.conversion.hasOnlineBooking ? t.advHas(audit.companyName) : t.advNone,
    },
    durationMs: Date.now() - start,
  };
}
