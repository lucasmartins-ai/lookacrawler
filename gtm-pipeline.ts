/**
 * GTM pipeline: Maps discovery -> enrichment -> outreach copy draft -> sink.
 *
 * Draft only. Nothing is sent and nothing leaves the machine except the
 * crawler's own guarded fetches. Copy states only what was observed (name,
 * city, Google rating) and is linted by anti-slop-linter; review before use.
 */

import { writeFile } from "node:fs/promises";
import { discoverLocalLeads, type GoogleMapsLead } from "./maps-bridge.js";
import { deepEnrichLead, type EnrichedLeadResult } from "./enrichment-bridge.js";
import { extractDomain, type Locale } from "./competitor-intelligence.js";
import { lintAntiSlop } from "./anti-slop-linter.js";
import { toSafeCsv } from "./csv-safe.js";

export type Channel = "WHATSAPP" | "EMAIL" | "INSTAGRAM_DM" | "PHONE";

export interface GtmOptions {
  niche: string;
  location?: string;
  limit?: number;
  /** What you offer, in one short phrase, used verbatim in the draft. */
  offer?: string;
  /** "auto" picks from the lead's country/address. */
  locale?: Locale | "auto";
  mode?: "fast" | "deep";
  concurrency?: number;
  /** Lead source; defaults to the Maps scraper. Injectable so tests stay offline. */
  discover?: (query: string, opts: { limit: number }) => Promise<{ data: GoogleMapsLead[]; total: number }>;
}

export interface GtmItem {
  title: string;
  domain: string;
  website?: string;
  address?: string;
  phone?: string;
  whatsapp?: string;
  emails: string[];
  decisionMakers: string[];
  instagram?: string;
  linkedin?: string;
  facebook?: string;
  rating?: number;
  reviews?: number;
  enrichmentSuccess: boolean;
  channel: Channel;
  destination: string;
  locale: Locale;
  outreachCopy: string;
  slopScore: number;
  error?: string;
}

export interface GtmResult {
  query: string;
  totalDiscovered: number;
  totalEnriched: number;
  durationMs: number;
  items: GtmItem[];
}

// Drafts exist in pt-BR and English only: Portuguese for BR/PT, English elsewhere.
const PT_COUNTRIES = new Set(["BR", "PT"]);

/** Country from Maps wins; otherwise a keyword/postcode guess over address + location. */
export function detectLocale(lead?: Partial<GoogleMapsLead>, address?: string, location?: string): Locale {
  const country = lead?.complete_address?.country?.toUpperCase();
  if (country) return PT_COUNTRIES.has(country) ? "pt" : "en";
  const text = `${address || ""} ${location || ""}`.toLowerCase();
  if (/\b(uk|united kingdom|england|scotland|wales|ireland|usa|united states|australia|canada)\b/.test(text)) return "en";
  if (/\b[a-z]{1,2}\d[a-z\d]?\s*\d[a-z]{2}\b/.test(text)) return "en"; // UK postcode
  return "pt";
}

function cityOf(address?: string): string | undefined {
  if (!address) return undefined;
  const br = address.match(/([A-Za-zÀ-ÖØ-öø-ÿ ]{3,})\s*-\s*[A-Z]{2}\b/); // "Cidade - UF"
  if (br) return br[1].split(",").pop()!.trim();
  const parts = address.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  const candidate = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  return candidate && !/\d/.test(candidate) ? candidate : undefined;
}

const DEFAULT_OFFER = {
  pt: "automações de resposta e agendamento para reduzir contatos perdidos",
  en: "reply and booking automation that cuts missed enquiries",
};

/** Draft one message from observed facts only. */
export function draftOutreach(
  lead: EnrichedLeadResult,
  raw: Partial<GoogleMapsLead> | undefined,
  opts: { niche: string; location?: string; offer?: string; locale?: Locale | "auto" }
): { channel: Channel; destination: string; locale: Locale; copy: string } {
  const channel: Channel = lead.whatsapp ? "WHATSAPP" : lead.emails.length ? "EMAIL" : lead.socialLinks.instagram ? "INSTAGRAM_DM" : "PHONE";
  const destination = lead.whatsapp || lead.emails[0] || lead.socialLinks.instagram || lead.phone || "";
  const locale = opts.locale && opts.locale !== "auto" ? opts.locale : detectLocale(raw, lead.address, opts.location);
  const en = locale === "en";
  const offer = opts.offer?.trim() || DEFAULT_OFFER[locale];
  const found = raw?.complete_address?.city || cityOf(lead.address);
  const city = found && !lead.title.toLowerCase().includes(found.toLowerCase()) ? found : undefined; // "Clinic - Goiânia em Goiânia"
  const person = lead.decisionMakers[0];
  const rating = lead.rating && lead.reviews ? (en ? ` (${lead.rating}★, ${lead.reviews} Google reviews)` : ` (nota ${lead.rating}★, ${lead.reviews} avaliações no Google)`) : "";

  const copy = en
    ? `Hi ${person || `${lead.title} team`},\n\nI came across ${lead.title}${city ? ` in ${city}` : ""}${rating}.\n\nI work on ${offer} for ${opts.niche} businesses.\n\nWould a 10-minute call this week be useful?`
    : `Olá ${person || `equipe da ${lead.title}`}, tudo bem?\n\nConheci a ${lead.title}${city ? ` em ${city}` : ""}${rating}.\n\nTrabalho com ${offer} para negócios de ${opts.niche}.\n\nFaz sentido conversarmos 10 minutos esta semana?`;
  return { channel, destination, locale, copy };
}

/** A lead with no usable site is kept (phone/WhatsApp from Maps) but not crawled. */
function bareLead(raw: GoogleMapsLead): EnrichedLeadResult {
  return {
    title: raw.title, category: raw.category, address: raw.address, phone: raw.phone, whatsapp: raw.whatsapp_link,
    website: raw.web_site, rating: raw.review_rating, reviews: raw.review_count,
    emails: raw.emails ? [...raw.emails] : [], socialLinks: {}, additionalPhones: [], decisionMakers: [],
    markdownSummary: "", estimatedTokens: 0, sourcePagesCrawled: [], enrichmentSuccess: false,
  };
}

export async function runGtmPipeline(options: GtmOptions): Promise<GtmResult> {
  const start = Date.now();
  const query = [options.niche, options.location].filter(Boolean).join(" ");
  const limit = Math.max(1, options.limit ?? 5);
  const concurrency = Math.max(1, Math.min(5, options.concurrency ?? 3));

  const found = await (options.discover ?? discoverLocalLeads)(query, { limit });
  const leads = found.data.slice(0, limit);

  let enriched = 0;
  const items: GtmItem[] = new Array(leads.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, leads.length) }, async () => {
      while (next < leads.length) {
        const i = next++;
        const raw = leads[i];
        let lead = bareLead(raw);
        if (raw.web_site?.startsWith("http")) {
          lead = await deepEnrichLead(raw, { mode: options.mode ?? "fast" });
          if (lead.enrichmentSuccess) enriched++;
        }
        const o = draftOutreach(lead, raw, { niche: options.niche, location: options.location, offer: options.offer, locale: options.locale });
        items[i] = {
          title: lead.title,
          domain: extractDomain(lead.website, lead.title),
          website: lead.website,
          address: lead.address,
          phone: lead.phone,
          whatsapp: lead.whatsapp,
          emails: lead.emails,
          decisionMakers: lead.decisionMakers,
          instagram: lead.socialLinks.instagram,
          linkedin: lead.socialLinks.linkedin,
          facebook: lead.socialLinks.facebook,
          rating: lead.rating,
          reviews: lead.reviews,
          enrichmentSuccess: lead.enrichmentSuccess,
          channel: o.channel,
          destination: o.destination,
          locale: o.locale,
          outreachCopy: o.copy,
          slopScore: lintAntiSlop(o.copy, o.locale).slopScore,
          ...(lead.error ? { error: lead.error } : {}),
        };
      }
    })
  );

  return { query, totalDiscovered: found.total, totalEnriched: enriched, durationMs: Date.now() - start, items };
}

const CSV_HEADERS = ["title", "domain", "website", "address", "phone", "whatsapp", "emails", "decisionMakers", "instagram", "linkedin", "facebook", "rating", "reviews", "channel", "destination", "locale", "slopScore", "outreachCopy", "error"];

/** `.csv` -> formula-injection-safe CSV; anything else -> JSONL (one item per line). */
export async function writeGtmSink(file: string, items: GtmItem[]): Promise<void> {
  if (/\.csv$/i.test(file)) {
    const rows = items.map((it) => CSV_HEADERS.map((h) => {
      const v = (it as unknown as Record<string, unknown>)[h];
      return Array.isArray(v) ? v.join("; ") : (v as string | number | undefined);
    }));
    await writeFile(file, toSafeCsv(CSV_HEADERS, rows), "utf8");
  } else {
    await writeFile(file, items.map((it) => JSON.stringify(it)).join("\n") + (items.length ? "\n" : ""), "utf8");
  }
}
