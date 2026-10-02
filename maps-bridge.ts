import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface GoogleMapsLead {
  input_id?: string;
  link?: string;
  cid?: string;
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
  const candidates = [
    path.resolve(__dirname, "../google-maps-scraper/maps-leads"),
    path.resolve(__dirname, "../../google-maps-scraper/maps-leads"),
    path.resolve(process.cwd(), "google-maps-scraper/maps-leads"),
    path.resolve(process.cwd(), "../google-maps-scraper/maps-leads"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Format international E.164 WhatsApp link based on phone format and location context.
 */
export function formatWhatsAppLink(phone?: string, address?: string, country?: string): string | undefined {
  if (!phone) return undefined;
  const raw = phone.trim();
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length < 8) return undefined;

  // Case 1: Phone already has explicit '+' international indicator
  if (raw.startsWith("+")) {
    return `https://wa.me/${digits}`;
  }

  const loc = `${address || ""} ${country || ""}`.toLowerCase();

  // Case 2: UK numbers
  const isUK =
    loc.includes("uk") ||
    loc.includes("united kingdom") ||
    loc.includes("bristol") ||
    loc.includes("london") ||
    loc.includes("manchester") ||
    loc.includes("liverpool") ||
    loc.includes("birmingham") ||
    loc.includes("leeds") ||
    loc.includes("sheffield") ||
    loc.includes("cardiff") ||
    loc.includes("southampton");

  if (isUK) {
    if (digits.startsWith("44") && digits.length >= 11) {
      return `https://wa.me/${digits}`;
    }
    if (digits.startsWith("0")) {
      return `https://wa.me/44${digits.slice(1)}`;
    }
    return `https://wa.me/44${digits}`;
  }

  // Case 3: US / Canada (10 digits or 1 + 10 digits)
  const isUS = loc.includes("usa") || loc.includes("united states") || loc.includes("us");
  if (isUS) {
    if (digits.startsWith("1") && digits.length === 11) {
      return `https://wa.me/${digits}`;
    }
    if (digits.length === 10) {
      return `https://wa.me/1${digits}`;
    }
  }

  // No E.164 number starts with 0, so a leading zero means this is a national
  // long-distance form (0 + carrier code, e.g. "(011) 99123-4567"). The area
  // code is not in the string and no case below can recover it, so guessing
  // yields a wa.me link that dials nothing. Refuse before any BR formatting
  // tries to pad it into a valid-looking 11 digits.
  if (digits.startsWith("0")) {
    return undefined;
  }

  // Case 4: Brazil (DDD + 8 or 9 digits)
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    return `https://wa.me/${digits}`;
  }
  if (digits.length === 10 || digits.length === 11) {
    return `https://wa.me/55${digits}`;
  }

  // Fallback: If 11 or more digits, use as international digits
  if (digits.length >= 11) {
    return `https://wa.me/${digits}`;
  }

  return undefined;
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

  let whatsappLink: string | undefined = undefined;
  if (phone) {
    whatsappLink = formatWhatsAppLink(phone, address, rawCountry);
  }

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
  const depth = options.depth || Math.max(1, Math.min(10, Math.ceil(limit / 10)));
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

  const createRes = await fetch(`${baseUrl}/api/v1/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(jobPayload),
  });

  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => "");
    throw new Error(`Erro ao criar job no daemon (HTTP ${createRes.status}): ${errText}`);
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
      const pollRes = await fetch(`${baseUrl}/api/v1/jobs/${jobId}`);
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
            const peekRes = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/results?limit=${limit}`);
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

  // Fetch results (retry once if needed)
  let resultsRes = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/results?limit=${limit}`);
  if (!resultsRes.ok) {
    await new Promise((r) => setTimeout(r, 600));
    resultsRes = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/results?limit=${limit}`);
  }
  if (!resultsRes.ok) {
    const errText = await resultsRes.text().catch(() => "");
    throw new Error(
      `Falha ao buscar resultados do job ${jobId} (HTTP ${resultsRes.status}): ${errText}`
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
      error: "Binário 'maps-leads' não encontrado nos caminhos padrão.",
    };
  }

  const fullQuery = options.location
    ? `${query.trim()} ${options.location.trim()}`
    : query.trim();

  const limit = options.limit || 20;
  const depth = options.depth || Math.max(1, Math.min(10, Math.ceil(limit / 10)));
  const concurrency = options.concurrency || 2;
  const lang = options.lang || "pt";
  const timeoutMs = options.timeoutMs || 90000;

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

  const homeDir = os.homedir();
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH:
      process.env.PLAYWRIGHT_BROWSERS_PATH ||
      path.join(homeDir, "Library/Caches/ms-playwright"),
    PLAYWRIGHT_NODEJS_PATH:
      process.env.PLAYWRIGHT_NODEJS_PATH || "/Users/Master/.local/bin/node",
  };

  return new Promise((resolve) => {
    let child: any;
    let stderrBuffer = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
    }, timeoutMs);

    try {
      child = spawn(binaryPath, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
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
        error: `Falha ao iniciar processo maps-leads: ${err?.message}`,
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
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {}
      }

      resolve({
        success: leads.length > 0 || code === 0,
        data: leads,
        total: leads.length,
        query: fullQuery,
        executionTimeMs: Date.now() - startTime,
        source: "cli",
        error:
          leads.length === 0 && code !== 0
            ? timedOut
              ? "Timeout atingido durante busca no Google Maps."
              : `Processo finalizou com erro (code ${code}): ${stderrBuffer.slice(0, 300)}`
            : undefined,
      });
    };

    const processLine = (trimmed: string) => {
      if (!trimmed || !trimmed.startsWith("{")) return;
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed.title || parsed.title.trim().length === 0) return;

        const dedupKey = parsed.cid || `${parsed.title}_${parsed.address || ""}`.toLowerCase();
        if (seenIds.has(dedupKey)) return;
        seenIds.add(dedupKey);

        let whatsappLink: string | undefined = undefined;
        if (Array.isArray(parsed.link_sources)) {
          for (const ls of parsed.link_sources) {
            if (ls?.link && ls.link.includes("whatsapp.com")) {
              whatsappLink = ls.link;
              break;
            }
          }
        }

        if (!whatsappLink && parsed.phone) {
          whatsappLink = formatWhatsAppLink(
            parsed.phone,
            parsed.address,
            parsed.complete_address?.country
          );
        }

        const lead: GoogleMapsLead = {
          input_id: parsed.input_id,
          link: parsed.link,
          cid: parsed.cid,
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
          emails: parsed.emails || undefined,
        };

        leads.push(lead);
        if (leads.length >= limit) {
          finish(0);
        }
      } catch {}
    };

    child.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        processLine(line.trim());
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
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
        error: `Erro no processo maps-leads: ${err.message}`,
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
