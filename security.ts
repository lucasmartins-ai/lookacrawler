import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_RESPONSE_BYTES = Number(process.env.LOOKACRAWLER_MAX_RESPONSE_BYTES || 10 * 1024 * 1024);
const DNS_CACHE_TTL_MS = 60_000;
const dnsCache = new Map<string, { expiresAt: number; isPrivate: boolean }>();

const BLOCKED_MESSAGE = "Requests to private or local hosts are not allowed";

export function isLocalAccessAllowed(): boolean {
  return process.env.LOOKACRAWLER_ALLOW_LOCAL === "true";
}

function isPrivateIPv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    octets[0] === 0 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) || // IETF protocol assignments (RFC 6890)
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) || // Carrier-Grade NAT (RFC 6598)
    (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) || // Benchmark network (RFC 2544)
    octets[0] >= 224 // Multicast & reserved
  );
}

/** Expand an IPv6 literal into its eight 16-bit groups (handles `::` and a trailing dotted quad). */
function parseIPv6(address: string): number[] | null {
  let addr = address.split("%")[0]; // drop zone id
  const lastColon = addr.lastIndexOf(":");
  const maybeV4 = addr.slice(lastColon + 1);
  if (isIP(maybeV4) === 4) {
    // Rewrite a trailing dotted quad (::ffff:1.2.3.4) as two hex groups.
    const o = maybeV4.split(".").map(Number);
    addr = `${addr.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...new Array(fill).fill(0), ...rest];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function embeddedIPv4(g: number[], hi: number, lo: number): string {
  return `${g[hi] >> 8}.${g[hi] & 0xff}.${g[lo] >> 8}.${g[lo] & 0xff}`;
}

export function isPrivateAddress(address: string): boolean {
  if (address === "localhost" || address.endsWith(".localhost")) return true;
  if (isIP(address) === 4) return isPrivateIPv4(address);

  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  // Hostnames such as fda.gov or fc2.com must not hit the IPv6 prefix checks below.
  if (isIP(normalized) !== 6) return false;
  const g = parseIPv6(normalized);
  if (!g) return true; // unparseable IPv6 literal: fail closed

  const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
  // ::ffff:a.b.c.d (IPv4-mapped, also written ::ffff:7f00:1 after URL normalisation)
  if (firstFiveZero && g[5] === 0xffff) return isPrivateIPv4(embeddedIPv4(g, 6, 7));
  // ::a.b.c.d (deprecated IPv4-compatible), including :: and ::1
  if (firstFiveZero && g[5] === 0) {
    if (g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;
    return isPrivateIPv4(embeddedIPv4(g, 6, 7));
  }
  // 64:ff9b::/96 NAT64 maps straight onto IPv4
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isPrivateIPv4(embeddedIPv4(g, 6, 7));
  }
  // 2002::/16 6to4 embeds the IPv4 address in groups 1-2
  if (g[0] === 0x2002) return isPrivateIPv4(embeddedIPv4(g, 1, 2));
  return (
    (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g[0] & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (g[0] & 0xff00) === 0xff00 // multicast
  );
}

/**
 * Resolve a hostname and return an address that is safe to connect to.
 *
 * Every resolved address must be public; the caller then connects to the
 * returned IP instead of resolving again, so a second (rebinding) DNS answer
 * can never redirect the connection to an internal host.
 */
export async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const allowLocal = isLocalAccessAllowed();
  const literal = isIP(host);
  if (literal) {
    if (!allowLocal && isPrivateAddress(host)) throw new Error(BLOCKED_MESSAGE);
    return { address: host, family: literal as 4 | 6 };
  }
  if (!allowLocal && isPrivateAddress(host)) throw new Error(BLOCKED_MESSAGE);
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`Could not resolve ${host}`);
  if (!allowLocal && addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error(BLOCKED_MESSAGE);
  }
  const chosen = addresses.find((a) => a.family === 4) || addresses[0];
  return { address: chosen.address, family: chosen.family as 4 | 6 };
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

  if (isLocalAccessAllowed()) {
    return;
  }

  if (parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost") || isPrivateAddress(parsed.hostname)) {
    throw new Error(BLOCKED_MESSAGE);
  }

  // A literal public IP needs no lookup (and dns.lookup chokes on "[v6]").
  if (isIP(parsed.hostname.replace(/^\[|\]$/g, ""))) return;

  const cached = dnsCache.get(parsed.hostname);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.isPrivate) throw new Error(BLOCKED_MESSAGE);
    return;
  }

  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  const privateHost = addresses.some(({ address }) => isPrivateAddress(address));
  dnsCache.set(parsed.hostname, { expiresAt: Date.now() + DNS_CACHE_TTL_MS, isPrivate: privateHost });
  if (privateHost) {
    throw new Error(BLOCKED_MESSAGE);
  }
}

const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:", "socks4:"]);

function operatorProxies(): Set<string> {
  const raw = [process.env.LOOKACRAWLER_PROXIES, process.env.LOOKACRAWLER_ALLOWED_PROXIES]
    .filter(Boolean)
    .join(",");
  return new Set(
    raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
  );
}

/**
 * Validate a proxy URL supplied with a request (MCP tool argument or CLI flag).
 *
 * The proxy is a connection target like any other: without this check a caller
 * can point it at 127.0.0.1:6379 or the cloud metadata IP and make the crawler
 * talk to internal services. Proxies configured by the operator through
 * LOOKACRAWLER_PROXIES / LOOKACRAWLER_ALLOWED_PROXIES are trusted as-is, so a
 * local proxy (Tor, mitmproxy, a sidecar) still works when listed there.
 */
export async function validateProxyUrl(value: string): Promise<string> {
  const proxy = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(proxy);
  } catch {
    throw new Error("Proxy URL is invalid");
  }
  if (!PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("Proxy URL must use http, https, socks4 or socks5");
  }
  if (!parsed.hostname) throw new Error("Proxy URL is invalid");
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new Error("Proxy URL must not contain a path, query or fragment");
  }
  if (operatorProxies().has(proxy) || isLocalAccessAllowed()) return proxy;
  try {
    await resolvePublicAddress(parsed.hostname);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === BLOCKED_MESSAGE) {
      throw new Error(
        "Proxies on private or local hosts are not allowed (list trusted proxies in LOOKACRAWLER_ALLOWED_PROXIES)"
      );
    }
    throw error;
  }
  return proxy;
}

export function getMaxResponseBytes(): number {
  return MAX_RESPONSE_BYTES;
}
