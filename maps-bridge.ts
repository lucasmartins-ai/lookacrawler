import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CountryCode } from "libphonenumber-js";
import { countryToRegion, normalizePhone, type NormalizedPhone, type PhoneType } from "./quality/phone.js";

export interface GoogleMapsLead {
  input_id?: string;
  link?: string;
  cid?: string;
  /** Google's stable place id; the safest dedupe key across queries. */
  place_id?: string;
  title: string;
  category?: string;
  categories?: string[];
  address?: string;
  complete_address?: {
    borough?: string;
    street?: string;
    city?: string;
    postal_code?: string;
    state?: string;
    country?: string;
  };
  open_hours?: Record<string, string[]>;
  web_site?: string;
  phone?: string;
  plus_code?: string;
  review_count?: number;
  review_rating?: number;
  reviews_per_rating?: Record<number, number>;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  status?: string;
  owner?: {
    id?: string;
    name?: string;
    link?: string;
  };
  featured_image?: string;
  whatsapp_link?: string;
  /** Normalized listing phone, when it validates. */
  phone_e164?: string;
  /** Line type of the listing phone; a "fixed" whatsapp_link deserves less trust. */
  phone_type?: PhoneType;
  /**
   * Where `whatsapp_link` came from: "google" when the business itself listed a
   * WhatsApp link on its Maps profile, "phone" when it was built from the
   * listing phone (unconfirmed: the number may not be on WhatsApp).
   */
  whatsapp_source?: "google" | "phone";
  emails?: string[];
}

export interface MapsScrapeOptions {
  location?: string;
  limit?: number;
  depth?: number;
  concurrency?: number;
  lang?: string;
  fastMode?: boolean;
  timeoutMs?: number;
  /**
   * CLI mode: finish once this long passes without a new lead (after the first
   * one). maps-leads often keeps running after its last result, so waiting for
   * it to exit can take forever. Default 15000.
   */
  idleMs?: number;
  geo?: string;
  radius?: number;
  extractEmails?: boolean;
  preferDaemon?: boolean;
  daemonPort?: number;
  daemonUrl?: string;
  customBinaryPath?: string;
}

export interface MapsScrapeResult {
  success: boolean;
  data: GoogleMapsLead[];
  total: number;
  query: string;
  executionTimeMs: number;
  source?: "daemon" | "cli";
  error?: string;
}

/**
 * Locate the `maps-leads` executable across standard project paths.
 */
export function resolveMapsLeadsBinary(customPath?: string): string | null {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }
  if (process.env.MAPS_LEADS_BIN && fs.existsSync(process.env.MAPS_LEADS_BIN)) {
    return process.env.MAPS_LEADS_BIN;
  }

  // ponytail: no install step for a sibling binary. Add a `npx`-style fetch when
  // the scraper ships as a real npm package; until then MAPS_LEADS_BIN wins.
  const binaryName = process.platform === "win32" ? "maps-leads.exe" : "maps-leads";
  const candidates = [
    path.resolve(__dirname, "../google-maps-scraper", binaryName),
    path.resolve(__dirname, "../../google-maps-scraper", binaryName),
    path.resolve(process.cwd(), "google-maps-scraper", binaryName),
    path.resolve(process.cwd(), "../google-maps-scraper", binaryName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export interface WhatsAppLinkInfo {
  link: string;
  e164: string;
  /**
   * Line type of the number. Fixed lines still get a link — plenty of
   * Brazilian businesses run WhatsApp Business on a landline — but callers
   * should trust a "fixed" link less than a "mobile" one.
   */
  type: PhoneType;
  valid: boolean;
}

/**
 * Region for a listing: the structured `complete_address.country` wins; the
 * address text is only a fallback for records without it.
 */
function resolveListingRegion(address?: string, country?: string): CountryCode | undefined {
  const structured = countryToRegion(country);
  if (structured) return structured;

  const loc = `${address || ""} ${country || ""}`.toLowerCase();
  // Whole-word matches only: a substring test for "us" or "uk" also hits
  // Brazilian addresses such as "Rua Augusta" or "Setor Industrial".
  if (/\b(uk|united kingdom|bristol|london|manchester|liverpool|birmingham|leeds|sheffield|cardiff|southampton)\b/.test(loc)) {
    return "GB";
  }
  if (/\b(us|usa|united states)\b/.test(loc)) return "US";
  return undefined;
}

/**
 * Parse a listing phone into a wa.me link plus its E.164 form and line type.
 */
export function describeWhatsApp(phone?: string, address?: string, country?: string): WhatsAppLinkInfo | undefined {
  if (!phone) return undefined;
  const raw = phone.trim();
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length < 8) return undefined;

  const toInfo = (parsed: NormalizedPhone): WhatsAppLinkInfo => ({
    link: `https://wa.me/${parsed.e164.slice(1)}`,
    e164: parsed.e164,
    type: parsed.type,
    valid: parsed.valid,
  });

  // Case 1: explicit international number. Trust the source even when the
  // metadata does not know the range yet.
  if (raw.startsWith("+")) {
    const parsed = normalizePhone(raw, { context: "maps" });
    if (parsed && parsed.valid) return toInfo(parsed);
    return { link: `https://wa.me/${digits}`, e164: `+${digits}`, type: "unknown", valid: false };
  }

  const region = resolveListingRegion(address, country) || "BR";

  // No E.164 number starts with 0, so in Brazil a leading zero means a
  // national long-distance form (0 + carrier code, e.g. "(011) 99123-4567").
  // The area code is ambiguous there, and guessing yields a wa.me link that
  // dials nothing. Refuse instead.
  if (region === "BR" && digits.startsWith("0")) {
    return undefined;
  }

  const parsed = normalizePhone(raw, { defaultRegion: region, context: "maps" });
  if (parsed && parsed.valid) return toInfo(parsed);

  // Already-international digits without "+" (e.g. "447356026050"). Masked
  // strings are national by construction (and may be CPF/CNPJ), so skip them.
  if (digits.length >= 11 && /^[\d\s]+$/.test(raw)) {
    const intl = normalizePhone(`+${digits}`, { context: "maps" });
    if (intl && intl.valid) return toInfo(intl);
  }

  return undefined;
}

/**
 * Format international E.164 WhatsApp link based on phone format and location context.
 * Use describeWhatsApp to also get the line type (mobile vs fixed).
 */
export function formatWhatsAppLink(phone?: string, address?: string, country?: string): string | undefined {
  return describeWhatsApp(phone, address, country)?.link;
}

/**
 * Check if the Maps Scraper daemon is active and responding.
 */
export async function checkMapsDaemonHealth(
  daemonUrl: string = "http://127.0.0.1:8088",
  timeoutMs: number = 1500
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${daemonUrl.replace(/\/+$/, "")}/healthz`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Parse a CSV row returned by the daemon REST API into a GoogleMapsLead object.
 */
function parseDaemonRowToLead(row: string[], headerIndex: Map<string, number>): GoogleMapsLead {
  const get = (key: string): string => {
    const idx = headerIndex.get(key.toLowerCase());
    return idx !== undefined && idx < row.length ? row[idx] || "" : "";
  };

  const parseJson = <T>(val: string, fallback: T): T => {
    if (!val || val === "null") return fallback;
    try {
      return JSON.parse(val);
    } catch {
      return fallback;
    }
  };

  const sanitizeNumber = (str: string): string => {
    return str.replace(/^['"]|['"]$/g, "").trim();
  };

  const title = get("title");
  const address = get("address");
  const phone = sanitizeNumber(get("phone")) || undefined;
  const rawCountry = parseJson<{ country?: string }>(get("complete_address"), {}).country;

  const phoneInfo = phone ? describeWhatsApp(phone, address, rawCountry) : undefined;
  const whatsappLink = phoneInfo?.link;

  const rawLat = parseFloat(sanitizeNumber(get("latitude")));
  const rawLon = parseFloat(sanitizeNumber(get("longitude")));
  const rawRating = parseFloat(sanitizeNumber(get("review_rating")));
  const rawReviews = parseInt(sanitizeNumber(get("review_count")), 10);

  const rawEmails = get("emails");
  let emails: string[] | undefined = undefined;
  if (rawEmails) {
    emails = rawEmails
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
  }

  const lead: GoogleMapsLead = {
    input_id: get("input_id") || undefined,
    link: get("link") || undefined,
    cid: get("cid") || undefined,
    title,
    category: get("category") || undefined,
    categories: parseJson<string[]>(
      get("categories"),
      get("category") ? [get("category")] : []
    ),
    address: address || undefined,
    complete_address: parseJson(get("complete_address"), undefined),
    open_hours: parseJson(get("open_hours"), undefined),
    web_site: get("website") || undefined,
    phone,
    plus_code: get("plus_code") || undefined,
    review_count: isNaN(rawReviews) ? undefined : rawReviews,
    review_rating: isNaN(rawRating) ? undefined : rawRating,
    reviews_per_rating: parseJson(get("reviews_per_rating"), undefined),
    latitude: isNaN(rawLat) ? undefined : rawLat,
    longitude: isNaN(rawLon) ? undefined : rawLon,
    timezone: get("timezone") || undefined,
    status: get("status") || undefined,
    owner: parseJson(get("owner"), undefined),
    featured_image: get("thumbnail") || undefined,
    whatsapp_link: whatsappLink,
    phone_e164: phoneInfo?.valid ? phoneInfo.e164 : undefined,
    phone_type: phoneInfo?.type,
    emails: emails && emails.length > 0 ? emails : undefined,
  };

  return lead;
}

/**
 * Scrape local businesses using the background Maps Scraper Daemon via HTTP/REST.
 */
export async function discoverLocalLeadsViaDaemon(
  query: string,
  options: MapsScrapeOptions = {}
): Promise<MapsScrapeResult> {
  const startTime = Date.now();
  const daemonPort = options.daemonPort || 8088;
  const baseUrl = (options.daemonUrl || `http://127.0.0.1:${daemonPort}`).replace(/\/+$/, "");

  const fullQuery = options.location
    ? `${query.trim()} ${options.location.trim()}`
    : query.trim();

  const limit = options.limit || 20;
  // One scroll page. Measured 2026-10-12 on the bundled maps-leads: the same
  // query returns 18 leads at -depth 1 and 0 at -depth 2 (the browser dies
  // with "playwright: target closed" during the second scroll). A page holds
  // ~20 results, so more leads need more queries, not more depth.
  const depth = options.depth || 1;
  const lang = options.lang || "pt-BR";
  const timeoutMs = options.timeoutMs || 90000;

  let lat: string | undefined = undefined;
  let lon: string | undefined = undefined;
  if (options.geo) {
    const parts = options.geo.split(",");
    if (parts.length === 2) {
      lat = parts[0].trim();
      lon = parts[1].trim();
    }
  }

  const jobPayload = {
    name: `Looka_${Date.now()}`,
    data: {
      keywords: [fullQuery],
      lang: lang === "pt" ? "pt-BR" : lang,
      zoom: 15,
      fast_mode: Boolean(options.fastMode && lat && lon),
      depth,
      email: Boolean(options.extractEmails),
      lat,
      lon,
      radius: options.radius || 10000,
    },
  };

  // A daemon that accepts the connection but never answers would otherwise
  // hang the call: the poll deadline is only checked between iterations.
  const requestTimeout = () => AbortSignal.timeout(5000);

  const createRes = await fetch(`${baseUrl}/api/v1/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(jobPayload),
    signal: requestTimeout(),
  });

  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => "");
    throw new Error(`Failed to create daemon job (HTTP ${createRes.status}): ${errText}`);
  }

  const jobData: any = await createRes.json();
  const jobId = jobData.id;
  if (!jobId) {
    throw new Error("Job ID ausente na resposta do daemon.");
  }

  // Poll for completion
  const pollDeadline = Date.now() + timeoutMs;
  let finalStatus = "";

  while (Date.now() < pollDeadline) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const pollRes = await fetch(`${baseUrl}/api/v1/jobs/${jobId}`, { signal: requestTimeout() });
      if (pollRes.ok) {
        const pollData: any = await pollRes.json();
        finalStatus = pollData.status;
        if (
          finalStatus === "succeeded" ||
          finalStatus === "failed" ||
          finalStatus === "canceled" ||
          finalStatus === "timed_out" ||
          finalStatus === "interrupted"
        ) {
          break;
        }

        // Fast streaming return: if enough records are already written, finalize immediately
        if (Date.now() > startTime + 2500) {
          try {
            const peekRes = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/results?limit=${limit}`, {
              signal: requestTimeout(),
            });
            if (peekRes.ok) {
              const peekJson: any = await peekRes.json();
              if (Array.isArray(peekJson.rows) && peekJson.rows.length >= limit) {
                // All requested leads available! Cancel remaining in background and exit loop
                fetch(`${baseUrl}/api/v1/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => {});
                break;
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  // Deadline reached with the job still running: stop it instead of letting it
  // keep scraping in the background.
  if (Date.now() >= pollDeadline) {
    fetch(`${baseUrl}/api/v1/jobs/${jobId}/cancel`, { method: "POST", signal: requestTimeout() }).catch(() => {});
  }

  // Fetch results (retry once if needed)
  let resultsRes = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/results?limit=${limit}`, {
    signal: requestTimeout(),
  });
  if (!resultsRes.ok) {
    await new Promise((r) => setTimeout(r, 600));
    resultsRes = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/results?limit=${limit}`, {
      signal: requestTimeout(),
    });
  }
  if (!resultsRes.ok) {
    const errText = await resultsRes.text().catch(() => "");
    throw new Error(
      `Failed to fetch results for job ${jobId} (HTTP ${resultsRes.status}): ${errText}`
    );
  }

  const resultsJson: any = await resultsRes.json();
  const header: string[] = resultsJson.header || [];
  const headerIndex = new Map<string, number>();
  header.forEach((h, i) => headerIndex.set(h.toLowerCase().trim(), i));

  const rows: string[][] = resultsJson.rows || [];
  const leads: GoogleMapsLead[] = [];
  const seenIds = new Set<string>();

  for (const row of rows) {
    const lead = parseDaemonRowToLead(row, headerIndex);
    if (!lead.title || lead.title.trim().length === 0) continue;

    const dedupKey = lead.cid || `${lead.title}_${lead.address || ""}`.toLowerCase();
    if (seenIds.has(dedupKey)) continue;
    seenIds.add(dedupKey);

    leads.push(lead);
    if (leads.length >= limit) {
      break;
    }
  }

  return {
    success: leads.length > 0 || finalStatus === "succeeded",
    data: leads,
    total: leads.length,
    query: fullQuery,
    executionTimeMs: Date.now() - startTime,
    source: "daemon",
  };
}

/**
 * Scrape local businesses using the CLI binary via child_process spawn (fallback mode).
 */
export async function discoverLocalLeadsViaCli(
  query: string,
  options: MapsScrapeOptions = {}
): Promise<MapsScrapeResult> {
  const startTime = Date.now();
  const binaryPath = resolveMapsLeadsBinary(options.customBinaryPath);

  if (!binaryPath) {
    return {
      success: false,
      data: [],
      total: 0,
      query,
      executionTimeMs: Date.now() - startTime,
      source: "cli",
      error: "'maps-leads' binary not found in standard paths (set MAPS_LEADS_BIN).",
    };
  }

  const fullQuery = options.location
    ? `${query.trim()} ${options.location.trim()}`
    : query.trim();

  const limit = options.limit || 20;
  // One scroll page. Measured 2026-10-12 on the bundled maps-leads: the same
  // query returns 18 leads at -depth 1 and 0 at -depth 2 (the browser dies
  // with "playwright: target closed" during the second scroll). A page holds
  // ~20 results, so more leads need more queries, not more depth.
  const depth = options.depth || 1;
  const concurrency = options.concurrency || 2;
  const lang = options.lang || "pt";
  const timeoutMs = options.timeoutMs || 90000;
  const idleMs = options.idleMs || 15000;

  const args = [
    "scrape",
    "-input",
    "stdin",
    "-results",
    "stdout",
    "-json",
    "-c",
    String(concurrency),
    "-depth",
    String(depth),
    "-lang",
    lang,
    "-exit-on-inactivity",
    "20s",
  ];

  if (options.fastMode) {
    args.push("-fast-mode");
  }

  if (options.extractEmails) {
    args.push("-email");
  }

  if (options.geo) {
    args.push("-geo", options.geo);
  }

  if (options.radius) {
    args.push("-radius", String(options.radius));
  }

  // PLAYWRIGHT_BROWSERS_PATH / PLAYWRIGHT_NODEJS_PATH are inherited when set;
  // otherwise the driver falls back to its own per-OS defaults.
  const env = { ...process.env };

  return new Promise((resolve) => {
    let child: any;
    let stderrBuffer = "";
    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    // The scraper drives a browser that inherits its stdout, so the pipe (and
    // "close") can outlive the scraper itself. Never wait for it: finish on
    // limit, inactivity or timeout, and kill the whole process group.
    const timer = setTimeout(() => {
      timedOut = true;
      finish(null);
    }, timeoutMs);

    try {
      child = spawn(binaryPath, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (err: any) {
      clearTimeout(timer);
      return resolve({
        success: false,
        data: [],
        total: 0,
        query: fullQuery,
        executionTimeMs: Date.now() - startTime,
        source: "cli",
        error: `Failed to start maps-leads process: ${err?.message}`,
      });
    }

    let isResolved = false;
    const leads: GoogleMapsLead[] = [];
    const seenIds = new Set<string>();
    let lineBuffer = "";

    const finish = (code: number | null = 0) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      if (child) {
        try {
          process.kill(-child.pid, "SIGKILL"); // the scraper and its browser
        } catch {
          try { child.kill("SIGKILL"); } catch {}
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
      }

      // maps-leads exits 0 even when every job failed; an empty run that logged
      // errors is a failure, not "no businesses here".
      const scraperError = leads.length === 0
        ? (stderrBuffer.match(/"error":"([^"]+)"/)?.[1] ?? "")
        : "";
      resolve({
        success: leads.length > 0 || (code === 0 && !timedOut && !scraperError),
        data: leads,
        total: leads.length,
        query: fullQuery,
        executionTimeMs: Date.now() - startTime,
        source: "cli",
        error:
          leads.length === 0 && (code !== 0 || scraperError)
            ? timedOut
              ? "Timed out while searching Google Maps."
              : scraperError
                ? `maps-leads failed: ${scraperError}`
                : `Processo finalizou com erro (code ${code}): ${stderrBuffer.slice(0, 300)}`
            : undefined,
      });
    };

    const processLine = (trimmed: string) => {
      // `finish` hands `leads` to the caller; keep it at `limit` afterwards.
      if (isResolved) return;
      if (!trimmed || !trimmed.startsWith("{")) return;
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed.title || parsed.title.trim().length === 0) return;

        const dedupKey = parsed.cid || `${parsed.title}_${parsed.address || ""}`.toLowerCase();
        if (seenIds.has(dedupKey)) return;
        seenIds.add(dedupKey);

        let whatsappLink: string | undefined = undefined;
        let whatsappSource: GoogleMapsLead["whatsapp_source"];
        if (Array.isArray(parsed.link_sources)) {
          for (const ls of parsed.link_sources) {
            if (ls?.link && /whatsapp\.com|wa\.me\//.test(ls.link)) {
              whatsappLink = ls.link;
              whatsappSource = "google";
              break;
            }
          }
        }

        const phoneInfo = parsed.phone
          ? describeWhatsApp(parsed.phone, parsed.address, parsed.complete_address?.country)
          : undefined;
        if (!whatsappLink && phoneInfo?.link) {
          whatsappLink = phoneInfo.link;
          whatsappSource = "phone";
        }

        const lead: GoogleMapsLead = {
          input_id: parsed.input_id,
          link: parsed.link,
          cid: parsed.cid,
          place_id: parsed.place_id || undefined,
          title: parsed.title,
          category: parsed.category,
          categories: parsed.categories,
          address: parsed.address,
          complete_address: parsed.complete_address,
          open_hours: parsed.open_hours,
          web_site: parsed.web_site || undefined,
          phone: parsed.phone || undefined,
          plus_code: parsed.plus_code,
          review_count: parsed.review_count,
          review_rating: parsed.review_rating,
          reviews_per_rating: parsed.reviews_per_rating,
          latitude: parsed.latitude,
          longitude: parsed.longitude,
          timezone: parsed.timezone,
          status: parsed.status,
          owner: parsed.owner,
          featured_image: parsed.featured_image,
          whatsapp_link: whatsappLink,
          whatsapp_source: whatsappSource,
          phone_e164: phoneInfo?.valid ? phoneInfo.e164 : undefined,
          phone_type: phoneInfo?.type,
          emails: parsed.emails || undefined,
        };

        leads.push(lead);
        if (leads.length >= limit) {
          finish(0);
          return;
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(0), idleMs);
      } catch {}
    };

    // Decode as a stream so a multi-byte character split across two chunks
    // is reassembled instead of turning into U+FFFD ("São" -> "S��o").
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        processLine(line.trim());
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
    });

    child.on("error", (err: Error) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timer);
      resolve({
        success: false,
        data: [],
        total: 0,
        query: fullQuery,
        executionTimeMs: Date.now() - startTime,
        source: "cli",
        error: `maps-leads process error: ${err.message}`,
      });
    });

    child.on("close", (code: number | null) => {
      if (lineBuffer.trim()) {
        processLine(lineBuffer.trim());
      }
      finish(code);
    });

    // Send query to stdin and close write stream
    child.stdin.write(`${fullQuery}\n`);
    child.stdin.end();
  });
}

/**
 * Discover local businesses on Google Maps.
 * Seamlessly routes to the high-throughput local daemon if available,
 * and automatically falls back to standalone CLI execution otherwise.
 */
export async function discoverLocalLeads(
  query: string,
  options: MapsScrapeOptions = {}
): Promise<MapsScrapeResult> {
  const preferDaemon = options.preferDaemon !== false;
  const daemonPort = options.daemonPort || 8088;
  const daemonUrl = options.daemonUrl || `http://127.0.0.1:${daemonPort}`;

  if (preferDaemon) {
    const isDaemonUp = await checkMapsDaemonHealth(daemonUrl);
    if (isDaemonUp) {
      try {
        return await discoverLocalLeadsViaDaemon(query, options);
      } catch (err: any) {
        // Transparent fallback to CLI if daemon query fails
        console.warn(`[MapsBridge] Daemon error, falling back to CLI spawner: ${err?.message}`);
      }
    }
  }

  return discoverLocalLeadsViaCli(query, options);
}
