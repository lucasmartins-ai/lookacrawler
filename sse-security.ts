import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/**
 * Access control for the SSE (HTTP) transport.
 *
 * The SSE server can drive a headless browser against arbitrary URLs, so an
 * unauthenticated instance is an open proxy for anyone who can reach it — and
 * a browser tab on the same machine can reach 127.0.0.1. The rules:
 *
 *  1. Bound to a non-loopback address (e.g. 0.0.0.0 in Docker) the server
 *     always requires a bearer token. If LOOKACRAWLER_SSE_TOKEN is not set a
 *     random one is generated and printed once at startup.
 *  2. Requests carrying an Origin header (i.e. made by a web page) are refused
 *     unless that origin is listed in LOOKACRAWLER_SSE_ALLOWED_ORIGINS. CLI and
 *     desktop MCP clients send no Origin and are unaffected. CORS is only
 *     granted to those listed origins — never "*".
 *  3. On loopback without a token, the Host header must be a loopback name so a
 *     DNS-rebinding page (evil.example → 127.0.0.1) is refused.
 */

export interface SseSecurity {
  token?: string;
  generatedToken: boolean;
  allowedOrigins: Set<string>;
  loopback: boolean;
  port: number;
}

export type RequestVerdict = { ok: true } | { ok: false; status: number; error: string };

interface MinimalRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  return h === "::1";
}

export function resolveSseSecurity(host: string, port: number, env: NodeJS.ProcessEnv = process.env): SseSecurity {
  const loopback = isLoopbackHost(host);
  let token = env.LOOKACRAWLER_SSE_TOKEN?.trim() || undefined;
  let generatedToken = false;
  const allowUnauthenticated = env.LOOKACRAWLER_SSE_ALLOW_UNAUTHENTICATED === "true";
  if (!token && !loopback && !allowUnauthenticated) {
    token = randomBytes(24).toString("base64url");
    generatedToken = true;
  }
  const allowedOrigins = new Set(
    (env.LOOKACRAWLER_SSE_ALLOWED_ORIGINS || "")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean)
  );
  return { token, generatedToken, allowedOrigins, loopback, port };
}

function header(req: MinimalRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function tokenMatches(supplied: string | undefined, token: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function checkSseRequest(req: MinimalRequest, cfg: SseSecurity): RequestVerdict {
  const origin = header(req, "origin");
  if (origin && !cfg.allowedOrigins.has(origin.replace(/\/+$/, ""))) {
    return { ok: false, status: 403, error: "Origin not allowed" };
  }

  if (!cfg.token && cfg.loopback) {
    // Without a token, the Host header is what stops DNS rebinding.
    const hostHeader = header(req, "host") || "";
    const hostOnly = hostHeader.replace(/:\d+$/, "");
    if (!isLoopbackHost(hostOnly)) {
      return { ok: false, status: 403, error: "Host not allowed" };
    }
  }

  // CORS preflight carries no credentials; it only gets headers if the origin
  // passed the allowlist above.
  if (req.method === "OPTIONS") return { ok: true };

  if (cfg.token && !tokenMatches(header(req, "authorization"), cfg.token)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}

export function corsHeaders(req: MinimalRequest, cfg: SseSecurity): Record<string, string> {
  const origin = header(req, "origin");
  if (!origin || !cfg.allowedOrigins.has(origin.replace(/\/+$/, ""))) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}
