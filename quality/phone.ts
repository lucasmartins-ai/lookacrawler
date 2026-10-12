import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

export type PhoneType = "mobile" | "fixed" | "unknown";

/**
 * Where the raw string came from. `text` is free page text and gets the
 * strictest checks (bare digit runs there are usually ids or timestamps);
 * `tel` / `whatsapp` are explicit links and `maps` is a listing field.
 */
export type PhoneContext = "text" | "tel" | "whatsapp" | "maps";

export interface NormalizePhoneOptions {
  defaultRegion?: CountryCode;
  context?: PhoneContext;
}

export interface NormalizedPhone {
  e164: string;
  national: string;
  international: string;
  type: PhoneType;
  valid: boolean;
  /** Raw libphonenumber type (TOLL_FREE, SHARED_COST, ...) when known. */
  lineType?: string;
  country?: CountryCode;
}

// ANATEL area codes in use. Anything else after +55 is not a Brazilian number.
const BR_DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

// Digit strings that look like phones to a loose regex but are Brazilian
// document numbers, postal codes, money, dates or year ranges.
const NOT_A_PHONE = [
  /^\d{3}\.\d{3}\.\d{3}-\d{2}$/, // CPF
  /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/, // CNPJ
  /^\d{2}\.?\d{3}-\d{3}$/, // CEP
  /^(?:R\$\s?)?\d{1,3}(?:\.\d{3}){2,}(?:,\d{1,2})?$/, // 1.234.567 / R$ 1.234.567,00
  /^(?:19|20)\d{2}\s?[-–]\s?(?:19|20)\d{2}$/, // 2019-2026
];

function isValidCpf(d: string): boolean {
  if (/^(\d)\1{10}$/.test(d)) return false;
  for (const n of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(d[i]) * (n + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(d[n])) return false;
  }
  return true;
}

/**
 * Normalize a raw phone string into E.164 plus national/international
 * formatting and a mobile/fixed classification.
 *
 * Returns null when the input is not a phone at all (CPF, CNPJ, CEP, ids,
 * money, year ranges, too few digits). A parseable number that fails
 * validation comes back with `valid: false` so callers can decide.
 */
export function normalizePhone(raw: string | null | undefined, options: NormalizePhoneOptions = {}): NormalizedPhone | null {
  if (!raw) return null;
  const { defaultRegion = "BR", context = "text" } = options;

  let input = raw.trim().replace(/^(?:tel|callto|sms):/i, "");
  try {
    input = decodeURIComponent(input);
  } catch {
    /* keep raw */
  }
  input = input.trim();
  if (input.length === 0 || input.length > 40) return null;
  // Slashes only show up in dates and document numbers, never in one phone.
  if (input.includes("/")) return null;
  if (NOT_A_PHONE.some((re) => re.test(input))) return null;

  let digits = input.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;

  const hasPlus = input.startsWith("+");
  const bare = /^\d+$/.test(input);

  // Free text: a long unformatted digit run is almost always an id, an order
  // number or a unix timestamp (1712345678 parses as a valid DDD 17 line).
  // Only accept the shapes people actually type: DDD + 9-digit mobile, or the
  // same with the 55 country code in front.
  if (context === "text" && bare && defaultRegion === "BR") {
    const mobile11 = digits.length === 11 && digits[2] === "9";
    const intl = digits.length === 13 && digits.startsWith("55") && digits[4] === "9";
    if (!mobile11 && !intl) return null;
  }

  // A bare 11-digit run with valid CPF check digits is a CPF, not a mobile
  // ("11945678941" would otherwise read as DDD 11 + 9-digit mobile). Explicit
  // tel:/wa.me links are trusted. ~1% of real unformatted mobiles also pass the
  // check digits and are dropped; formatted ones are unaffected.
  if (bare && digits.length === 11 && (context === "text" || context === "maps") && isValidCpf(digits)) return null;

  // wa.me / api.whatsapp.com carry the number without "+".
  if (!hasPlus && (context === "whatsapp" || (bare && digits.length >= 12 && digits.startsWith("55")))) {
    input = `+${digits}`;
  }

  // Brazil moved every mobile to 9 digits by 2016; old pages still print
  // "(62) 8999-9999". Insert the 9 so the number dials and dedupes.
  const brNational = brNationalDigits(input, digits, defaultRegion);
  if (brNational && brNational.length === 10 && /[6-9]/.test(brNational[2]) && isValidBrazilianDdd(brNational.slice(0, 2))) {
    const fixedUp = `+55${brNational.slice(0, 2)}9${brNational.slice(2)}`;
    input = fixedUp;
    digits = fixedUp.slice(1);
  }

  const parsed = parsePhoneNumberFromString(input, defaultRegion);
  if (!parsed || !parsed.isPossible()) return null;

  const country = parsed.country;
  const nationalNumber = String(parsed.nationalNumber);
  const lineType = parsed.getType();
  let type: PhoneType = lineType === "MOBILE" ? "mobile" : lineType === "FIXED_LINE" ? "fixed" : "unknown";
  let valid = parsed.isValid();

  if (parsed.countryCallingCode === "55") {
    const br = classifyBrazilian(nationalNumber);
    if (br) {
      type = br;
    } else if (!lineType) {
      // Unknown DDD or a subscriber number in an unused range.
      valid = false;
    }
  }

  return {
    e164: parsed.number,
    national: parsed.formatNational(),
    international: parsed.formatInternational(),
    type,
    valid,
    lineType: lineType || undefined,
    country,
  };
}

/**
 * Stable dedupe key for a phone: its E.164 form, or null when the input does
 * not normalize to a valid number. "tel:+5562...", "(62) ..." and
 * "+55 62 ..." all map to the same key.
 */
export function phoneKey(raw: string | null | undefined, options: NormalizePhoneOptions = {}): string | null {
  const parsed = normalizePhone(raw, options);
  return parsed && parsed.valid ? parsed.e164 : null;
}

/**
 * Brazilian line type from the national number (DDD + subscriber):
 * mobile is 9 digits starting with 9, fixed is 8 digits starting with 2-5.
 */
export function classifyBrazilian(nationalNumber: string): PhoneType | null {
  if (!/^\d{10,11}$/.test(nationalNumber)) return null;
  if (!BR_DDDS.has(Number(nationalNumber.slice(0, 2)))) return null;
  const subscriber = nationalNumber.slice(2);
  if (subscriber.length === 9 && subscriber[0] === "9") return "mobile";
  if (subscriber.length === 8 && /[2-5]/.test(subscriber[0])) return "fixed";
  return null;
}

const COUNTRY_NAMES: Record<string, CountryCode> = {
  brasil: "BR", brazil: "BR", bra: "BR",
  "united states": "US", "united states of america": "US", usa: "US", "estados unidos": "US",
  "united kingdom": "GB", uk: "GB", england: "GB", scotland: "GB", wales: "GB", "reino unido": "GB",
  portugal: "PT", canada: "CA", "canadá": "CA", argentina: "AR", chile: "CL", uruguay: "UY", uruguai: "UY",
  paraguay: "PY", paraguai: "PY", mexico: "MX", "méxico": "MX", spain: "ES", espanha: "ES", "españa": "ES",
  germany: "DE", alemanha: "DE", france: "FR", "frança": "FR", italy: "IT", "itália": "IT", ireland: "IE",
  australia: "AU", "austrália": "AU",
};

/**
 * Region code for a structured country field ("BR", "Brazil", "Brasil",
 * "United States", ...). Returns undefined when unknown.
 */
export function countryToRegion(country: string | null | undefined): CountryCode | undefined {
  if (!country) return undefined;
  const value = country.trim();
  if (/^[A-Za-z]{2}$/.test(value)) {
    const code = value.toUpperCase();
    return (code === "UK" ? "GB" : code) as CountryCode;
  }
  return COUNTRY_NAMES[value.toLowerCase()];
}

export function isValidBrazilianDdd(ddd: string | number): boolean {
  return BR_DDDS.has(Number(ddd));
}

// Candidate phone tokens in free text. Every group has a small fixed bound,
// so each start position does constant work and the scan stays linear. The
// look-arounds keep it from starting or ending inside a longer number
// (CPF/CNPJ/CEP segments, ids, decimals).
const PHONE_CANDIDATE_REGEX =
  /(?<![\w.,\/@-])(?:\+\s?\d{1,3}[\s.-]?)?(?:\(\s?0?\d{2,3}\s?\)[\s.-]?|0?\d{2,3}[\s.-]?)?\d{3,5}[\s.-]?\d{4}(?![\w\/@]|[.,-]\d)/g;

/**
 * Find phone numbers in free text, normalized and deduplicated by E.164.
 * Only valid numbers are returned.
 */
const ID_LABEL_BEFORE =
  /(?:protocolo|pedido|n[º°o]|c[óo]d(?:igo)?|cpf|cnpj|rg|nota(?: fiscal)?|nfe?|id|matr[íi]cula|processo|ref(?:er[êe]ncia)?|sku|ean|boleto|conta|ag[êe]ncia|cart[ãa]o|order|invoice|ticket)\s*[:#.º°-]?\s*$/i;

export function findPhones(text: string, options: NormalizePhoneOptions = {}): NormalizedPhone[] {
  const out = new Map<string, NormalizedPhone>();
  for (const match of text.matchAll(PHONE_CANDIDATE_REGEX)) {
    // "Protocolo 12945678909", "Pedido nº 11987654321": an unformatted digit run
    // right after an identifier label is that identifier, not a phone. Formatted
    // numbers ("Pedidos: (11) 98765-4321") are still accepted.
    if (/^\d+$/.test(match[0]) && ID_LABEL_BEFORE.test(text.slice(Math.max(0, match.index! - 30), match.index))) continue;
    const parsed = normalizePhone(match[0], { ...options, context: options.context || "text" });
    if (parsed && parsed.valid && !out.has(parsed.e164)) {
      out.set(parsed.e164, parsed);
    }
  }
  return Array.from(out.values());
}

/**
 * National digits (DDD + subscriber) when the input is a Brazilian number
 * written with or without +55, otherwise null.
 */
function brNationalDigits(input: string, digits: string, region: CountryCode): string | null {
  if (input.startsWith("+")) {
    return digits.startsWith("55") && (digits.length === 12 || digits.length === 13) ? digits.slice(2) : null;
  }
  if (region !== "BR") return null;
  if (digits.length === 10 || digits.length === 11) return digits;
  return null;
}
