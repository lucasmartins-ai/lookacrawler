import { lookup } from "node:dns/promises";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const MAX_RESPONSE_BYTES = Number(process.env.LOOKACRAWLER_MAX_RESPONSE_BYTES || 10 * 1024 * 1024);
const DNS_CACHE_TTL_MS = 60_000;
const dnsCache = new Map<string, { expiresAt: number; isPrivate: boolean }>();

export function isPrivateAddress(address: string): boolean {
  if (address === "localhost" || address.endsWith(".localhost")) return true;
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      octets[0] === 0 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) || // Carrier-Grade NAT (RFC 6598)
      (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) || // Benchmark network (RFC 2544)
      octets[0] >= 224 // Multicast & reserved
    );
  }

  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (normalized.startsWith("::") && isIP(normalized.slice(2)) === 4) {
    return isPrivateAddress(normalized.slice(2));
  }
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized === "::"
  );
}

// ponytail: check-then-fetch. fetch() re-resolves DNS, so a rebinding server
// can flip to a private IP between this check and the request (TOCTOU). Closing
// it needs IP pinning (custom lookup/agent), which Bun's fetch doesn't expose yet.
export async function validateTargetUrl(value: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Target URL is invalid");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP/HTTPS target URLs are allowed");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Target URLs cannot contain credentials");
  }

  if (process.env.LOOKACRAWLER_ALLOW_LOCAL === "true") {
    return;
  }

  if (parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost") || isPrivateAddress(parsed.hostname)) {
    throw new Error("Requests to private or local hosts are not allowed");
  }

  const cached = dnsCache.get(parsed.hostname);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.isPrivate) throw new Error("Requests to private or local hosts are not allowed");
    return;
  }

  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  const privateHost = addresses.some(({ address }) => isPrivateAddress(address));
  dnsCache.set(parsed.hostname, { expiresAt: Date.now() + DNS_CACHE_TTL_MS, isPrivate: privateHost });
  if (privateHost) {
    throw new Error("Requests to private or local hosts are not allowed");
  }
}

export function getMaxResponseBytes(): number {
  return MAX_RESPONSE_BYTES;
}

/**
 * Read a response body while enforcing the size cap *during* the read, so a
 * server that omits Content-Length cannot make us buffer an unbounded body.
 */
export async function readBodyCapped(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response exceeds maximum size of ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function hostnameOf(hostHeader: string): string {
  // "[::1]:3000" -> "[::1]", "localhost:3000" -> "localhost"
  return hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0];
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const a = Buffer.from(header || "");
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SseGateInput {
  bindHost: string;
  token?: string;
  allowedOrigins: string[];
  headers: { host?: string; origin?: string; authorization?: string };
}

/**
 * Decide whether an SSE-transport HTTP request may proceed.
 * Returns null when allowed, or the status + error to reply with.
 *
 * - Loopback bind: Host header must be loopback (blocks DNS rebinding).
 * - Any request carrying an Origin must match LOOKACRAWLER_CORS_ORIGIN
 *   (browsers always send Origin cross-site; native MCP clients don't).
 * - Token, when configured, is compared in constant time.
 */
export function checkSseRequest({ bindHost, token, allowedOrigins, headers }: SseGateInput): { status: number; error: string } | null {
  if (isLoopbackHost(bindHost) && !isLoopbackHost(hostnameOf(headers.host || ""))) {
    return { status: 403, error: "Forbidden host" };
  }
  if (headers.origin && !allowedOrigins.includes(headers.origin)) {
    return { status: 403, error: "Forbidden origin" };
  }
  if (token && !tokenMatches(headers.authorization, token)) {
    return { status: 401, error: "Unauthorized" };
  }
  return null;
}
