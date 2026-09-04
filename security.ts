import { lookup } from "node:dns/promises";
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
