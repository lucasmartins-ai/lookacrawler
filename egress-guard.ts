import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isOperatorProxy, isLocalAccessAllowed, parseIPv6, resolvePublicAddress } from "./security.js";
import { registerCleanup } from "./lifecycle.js";

/**
 * Egress guard: a tiny loopback HTTP/CONNECT proxy that every outbound
 * connection goes through.
 *
 * Validating a URL before handing it to fetch/Chromium is not enough:
 *  - Chromium follows redirects without calling `page.route` again, and
 *    fetch/xhr/WebSocket traffic started by the page never passes our checks.
 *  - The hostname is resolved once for validation and again for the
 *    connection, so a DNS-rebinding server can answer "public" then "127.0.0.1".
 *
 * The guard closes both gaps at the only place that cannot be bypassed — the
 * socket. It resolves the destination once, rejects private/local addresses,
 * and connects to exactly the IP it validated. HTTPS is tunnelled with CONNECT,
 * so the browser's own TLS fingerprint is preserved for anti-bot purposes.
 *
 * With an upstream proxy (caller `proxy` or LOOKACRAWLER_PROXIES) the chain is
 * client → guard → upstream → target: the guard still resolves and validates
 * the destination, then asks the upstream (HTTP CONNECT, SOCKS5 or SOCKS4) to
 * connect to the validated IP. The upstream never resolves the name, so it
 * cannot be steered to an internal host — including OUR loopback when the
 * upstream is a trusted local sidecar.
 *
 * Access is protected with random per-process credentials so other local
 * processes cannot use it as an open proxy. One listener serves every
 * upstream: each upstream gets its own password, and the password the client
 * presents selects the upstream (so a client can never pick one itself).
 */

export interface EgressGuard {
  /** Proxy URL with embedded credentials (for fetch). */
  url: string;
  /** Proxy server without credentials (for Playwright). */
  server: string;
  username: string;
  password: string;
}

export const BLOCKED_HEADER = "x-lookacrawler-blocked";

const USERNAME = "lc";
const DIRECT = ""; // route key for "no upstream proxy"
// ponytail: LRU of 1024 upstreams; an evicted route answers 407 until its next
// getEgressGuard() call re-registers it with the SAME password (HMAC of the route),
// so a running browser recovers instead of being locked out for good.
const MAX_ROUTES = 1024;
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_FORWARDED_BODY_BYTES = 1024 * 1024; // buffered per request; a crawler only sends small forms

let serverPromise: Promise<{ server: Server; port: number }> | null = null;
let guardServer: Server | null = null;
const guardSockets = new Set<net.Socket>();
/** Per-process key for deriving each route's password. */
const ROUTE_SECRET = randomBytes(32);
/** sha256(expected Proxy-Authorization header) → route key; insertion order = LRU order. */
const routes = new Map<string, string>();

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const authHeader = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

/** The upstream this request is authorized for (DIRECT for none), or null. */
function routeFor(req: IncomingMessage): string | null {
  const header = req.headers["proxy-authorization"];
  if (typeof header !== "string") return null;
  // Hashing first means the map lookup never compares the secret itself.
  return routes.get(digest(header)) ?? null;
}

function parseHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  // Parsed by hand: `new URL("http://host:80")` drops the port because 80 is
  // the http default, which would silently send CONNECT host:80 to 443.
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:\[\]\s]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1].replace(/^\[|\]$/g, ""), port };
}

function rejectSocket(socket: net.Socket, status: string, reason: string, extra = ""): void {
  const body = JSON.stringify({ error: reason });
  socket.end(
    `HTTP/1.1 ${status}\r\n${BLOCKED_HEADER}: 1\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${extra}\r\n${body}`
  );
}

const PROXY_AUTH_CHALLENGE = 'Proxy-Authenticate: Basic realm="lookacrawler"\r\n';
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function connectSocket(open: () => net.Socket): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const sock = open();
    sock.unref();
    sock.setTimeout(30_000, () => sock.destroy(new Error("upstream timeout")));
    sock.once("error", reject);
    sock.once(sock instanceof tls.TLSSocket ? "secureConnect" : "connect", () => {
      sock.off("error", reject);
      resolve(sock);
    });
  });
}

/**
 * Read a handshake off a socket. `take(fn)` waits until `fn(buffered)` returns
 * a length ≥ 0 and consumes that many bytes; `release()` hands the socket back
 * paused with any extra bytes unshifted, ready to be piped.
 */
function handshakeReader(sock: net.Socket) {
  let buf = Buffer.alloc(0);
  let failed: Error | null = null;
  let wake: (() => void) | null = null;
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    wake?.();
  };
  const onEnd = () => {
    failed ??= new Error("upstream proxy closed the connection");
    wake?.();
  };
  const onError = (error: Error) => {
    failed ??= error;
    wake?.();
  };
  sock.on("data", onData);
  sock.on("end", onEnd);
  sock.on("close", onEnd);
  sock.on("error", onError);
  sock.resume(); // a released (paused) socket does not resume on a new "data" listener
  return {
    async take(need: (b: Buffer) => number): Promise<Buffer> {
      for (;;) {
        const n = need(buf);
        if (n >= 0 && n <= buf.length) {
          const out = buf.subarray(0, n);
          buf = buf.subarray(n);
          return out;
        }
        if (failed) throw failed;
        if (buf.length > MAX_HEAD_BYTES) throw new Error("upstream proxy response too large");
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    },
    release(): Buffer {
      sock.pause();
      sock.off("data", onData);
      sock.off("end", onEnd);
      sock.off("close", onEnd);
      sock.off("error", onError);
      const rest = buf;
      buf = Buffer.alloc(0);
      return rest;
    },
  };
}

const upTo = (b: Buffer, n: number) => (b.length >= n ? n : -1);
const headEnd = (b: Buffer) => {
  const i = b.indexOf("\r\n\r\n");
  return i < 0 ? -1 : i + 4;
};

/** Open a tunnel to `address:port` (an IP the guard already validated) through `upstream`. */
async function tunnelVia(upstream: string, address: string, port: number): Promise<net.Socket> {
  const u = new URL(upstream);
  const proxyHost = u.hostname.replace(/^\[|\]$/g, "");
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  const scheme = u.protocol.slice(0, -1);
  const proxyPort = u.port ? Number(u.port) : scheme === "https" ? 443 : scheme === "http" ? 80 : 1080;
  // A caller-supplied proxy was validated as public; connect to the IP we
  // validate now so the proxy's own name cannot be rebound to loopback either.
  // Operator-listed proxies are trusted and may be local.
  const proxyAddress =
    isOperatorProxy(upstream) || isLocalAccessAllowed() ? proxyHost : (await resolvePublicAddress(proxyHost)).address;

  const sock = await connectSocket(() =>
    scheme === "https"
      ? tls.connect({ host: proxyAddress, port: proxyPort, servername: net.isIP(proxyHost) ? undefined : proxyHost })
      : net.connect({ host: proxyAddress, port: proxyPort })
  );
  const reader = handshakeReader(sock);
  try {
    const family = net.isIP(address);
    if (scheme === "http" || scheme === "https") {
      const authority = family === 6 ? `[${address}]:${port}` : `${address}:${port}`;
      const auth = user ? `Proxy-Authorization: ${authHeader(user, pass)}\r\n` : "";
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
      const head = (await reader.take(headEnd)).toString("latin1");
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1];
      if (!status?.startsWith("2")) throw new Error(`upstream proxy refused CONNECT (${status || "bad response"})`);
    } else if (scheme === "socks5" || scheme === "socks5h") {
      // RFC 1928 / 1929. Always sends an IP, so socks5 and socks5h behave alike.
      sock.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]));
      const [, method] = await reader.take((b) => upTo(b, 2));
      if (method === 2 && user) {
        const ub = Buffer.from(user);
        const pb = Buffer.from(pass);
        if (ub.length > 255 || pb.length > 255) throw new Error("SOCKS5 credentials too long");
        sock.write(Buffer.concat([Buffer.from([1, ub.length]), ub, Buffer.from([pb.length]), pb]));
        const [, ok] = await reader.take((b) => upTo(b, 2));
        if (ok !== 0) throw new Error("SOCKS5 authentication failed");
      } else if (method !== 0) {
        throw new Error("SOCKS5 proxy offered no acceptable auth method");
      }
      const addr = family === 6 ? Buffer.from(parseIPv6(address)!.flatMap((g) => [g >> 8, g & 0xff])) : Buffer.from(address.split(".").map(Number));
      const portBytes = Buffer.from([port >> 8, port & 0xff]);
      sock.write(Buffer.concat([Buffer.from([5, 1, 0, family === 6 ? 4 : 1]), addr, portBytes]));
      const reply = await reader.take((b) => {
        if (b.length < 5) return -1;
        const len = b[3] === 1 ? 4 : b[3] === 4 ? 16 : b[3] === 3 ? 1 + b[4] : 0;
        return 4 + len + 2;
      });
      if (reply[1] !== 0) throw new Error(`SOCKS5 CONNECT failed (code ${reply[1]})`);
    } else if (scheme === "socks4") {
      if (family !== 4) throw new Error("SOCKS4 proxies cannot reach IPv6 destinations");
      const ip = Buffer.from(address.split(".").map(Number));
      sock.write(Buffer.concat([Buffer.from([4, 1, port >> 8, port & 0xff]), ip, Buffer.from(user), Buffer.from([0])]));
      const reply = await reader.take((b) => upTo(b, 8));
      if (reply[1] !== 0x5a) throw new Error(`SOCKS4 CONNECT failed (code ${reply[1]})`);
    } else {
      throw new Error(`unsupported upstream proxy scheme ${scheme}`);
    }
  } catch (error) {
    sock.destroy();
    throw error;
  }
  const rest = reader.release();
  if (rest.length) sock.unshift(rest);
  return sock;
}

/** Connect to `address:port` (already validated), directly or through `upstream`. */
function openConnection(address: string, port: number, upstream: string): Promise<net.Socket> {
  if (upstream) return tunnelVia(upstream, address, port);
  return connectSocket(() => net.connect({ host: address, port }));
}

function pipeBoth(a: net.Socket, b: net.Socket): void {
  a.pipe(b);
  b.pipe(a);
  const close = () => {
    a.destroy();
    b.destroy();
  };
  a.on("error", close);
  b.on("error", close);
  a.on("close", close);
  b.on("close", close);
}

function forwardedHeaders(req: IncomingMessage, host: string): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith("proxy-") || name === "connection" || name === "keep-alive") continue;
    headers[name] = value;
  }
  headers.host = host;
  return headers;
}

/**
 * Plain-HTTP request through an upstream: tunnel to the validated IP and speak
 * HTTP/1.0 inside it. Bun's http client cannot run over a pre-made socket, and
 * HTTP/1.0 means no chunked framing, so the response body is simply every byte
 * until the server closes. The Host header keeps the original hostname.
 */
async function forwardOverTunnel(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  address: string,
  upstream: string
): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FORWARDED_BODY_BYTES) {
      res.writeHead(413, { [BLOCKED_HEADER]: "1" });
      res.end();
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const headers = forwardedHeaders(req, target.host);
  for (const name of ["transfer-encoding", "content-length", "te", "upgrade", "trailer"]) delete headers[name];
  if (body.length || req.headers["content-length"] !== undefined) headers["content-length"] = String(body.length);
  headers.connection = "close";

  const tunnel = await openConnection(address, target.port ? Number(target.port) : 80, upstream);
  let head = `${req.method} ${target.pathname}${target.search} HTTP/1.0\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    for (const v of Array.isArray(value) ? value : [value]) head += `${name}: ${v}\r\n`;
  }
  tunnel.write(Buffer.concat([Buffer.from(`${head}\r\n`, "latin1"), body]));

  const reader = handshakeReader(tunnel);
  let raw: string;
  try {
    raw = (await reader.take(headEnd)).toString("latin1");
  } catch (error) {
    tunnel.destroy();
    throw error;
  }
  const rest = reader.release();
  const [statusLine, ...lines] = raw.slice(0, -4).split("\r\n");
  const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(statusLine)?.[1]);
  if (!status) {
    tunnel.destroy();
    throw new Error("invalid response from target");
  }
  const out: Record<string, string | string[]> = {};
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    // The body is "everything until the target closes" (HTTP/1.0), so the client
    // connection closes too instead of trusting the target's Content-Length:
    // bytes past it could otherwise be read as the next response on a reused socket.
    if (name === "connection" || name === "keep-alive" || name === "transfer-encoding" || name === "content-length") continue;
    const value = line.slice(i + 1).trim();
    const prev = out[name];
    out[name] = prev === undefined ? value : [...(Array.isArray(prev) ? prev : [prev]), value];
  }
  out.connection = "close";
  res.writeHead(status, out);
  if (req.method === "HEAD" || status < 200 || status === 204 || status === 304) {
    tunnel.destroy();
    res.end();
    return;
  }
  if (rest.length) res.write(rest);
  // A small response often arrives together with the target's FIN, and the
  // handshake reader has already consumed "end": pipe() would then never end
  // res and the client would hang until the idle timeout.
  if (tunnel.readableEnded || tunnel.destroyed) {
    res.end();
    return;
  }
  tunnel.on("error", () => res.destroy());
  res.on("close", () => tunnel.destroy());
  tunnel.pipe(res);
  tunnel.resume();
}

function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    // Plain-HTTP request in absolute form: "GET http://host/path HTTP/1.1".
    const upstream = routeFor(req);
    if (upstream === null) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="lookacrawler"', [BLOCKED_HEADER]: "1" });
      res.end();
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url || "");
      if (target.protocol !== "http:") throw new Error("bad scheme");
    } catch {
      res.writeHead(400, { [BLOCKED_HEADER]: "1" });
      res.end();
      return;
    }
    let address: string;
    try {
      ({ address } = await resolvePublicAddress(target.hostname));
    } catch (error) {
      res.writeHead(403, { "Content-Type": "application/json", [BLOCKED_HEADER]: "1" });
      res.end(JSON.stringify({ error: errorMessage(error) }));
      return;
    }
    if (upstream) {
      forwardOverTunnel(req, res, target, address, upstream).catch(() => {
        if (!res.headersSent) res.writeHead(502, { [BLOCKED_HEADER]: "1" });
        res.end();
      });
      return;
    }
    // Connect to the exact IP we validated; never resolve the name again.
    const outbound = httpRequest(
      {
        host: address,
        port: target.port ? Number(target.port) : 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: forwardedHeaders(req, target.host),
        setHost: false,
        timeout: 30_000,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    outbound.on("socket", (sock) => sock.unref());
    outbound.on("timeout", () => outbound.destroy(new Error("upstream timeout")));
    outbound.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { [BLOCKED_HEADER]: "1" });
      res.end();
    });
    req.pipe(outbound);
  });

  server.on("connect", async (req: IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const upstream = routeFor(req);
    if (upstream === null) {
      rejectSocket(socket, "407 Proxy Authentication Required", "proxy authentication required", PROXY_AUTH_CHALLENGE);
      return;
    }
    const dest = parseHostPort(req.url || "", 443);
    if (!dest) {
      rejectSocket(socket, "400 Bad Request", "invalid CONNECT target");
      return;
    }
    let address: string;
    try {
      ({ address } = await resolvePublicAddress(dest.host));
    } catch (error) {
      // Refused before any upstream proxy is contacted.
      rejectSocket(socket, "403 Forbidden", errorMessage(error));
      return;
    }
    let outbound: net.Socket;
    try {
      outbound = await openConnection(address, dest.port, upstream);
    } catch (error) {
      rejectSocket(socket, "502 Bad Gateway", errorMessage(error));
      return;
    }
    // Bun hands "connect" a different socket object than "connection", so the
    // tunnel ends must be tracked here or stopEgressGuard() waits for the 30 s
    // idle timeout (every one-shot CLI run stalled ~5 s on exit because of it).
    for (const sock of [socket, outbound]) {
      sock.unref();
      guardSockets.add(sock);
      sock.once("close", () => guardSockets.delete(sock));
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) outbound.write(head);
    pipeBoth(socket, outbound);
  });

  // The guard must never keep the process alive on its own: the in-process
  // client (fetch / the awaited browser call) already does while a request is
  // in flight, and a short-lived CLI run has to exit as soon as it is done.
  server.on("connection", (sock: net.Socket) => {
    sock.unref();
    guardSockets.add(sock);
    sock.once("close", () => guardSockets.delete(sock));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("egress guard failed to bind"));
        return;
      }
      server.unref();
      guardServer = server;
      resolve({ server, port: address.port });
    });
  });
}

/** Password for a route: deterministic per process, refreshed in LRU order. */
function passwordFor(route: string): string {
  const password = createHmac("sha256", ROUTE_SECRET).update(route).digest("base64url");
  const key = digest(authHeader(USERNAME, password));
  routes.delete(key);
  routes.set(key, route);
  while (routes.size > MAX_ROUTES) routes.delete(routes.keys().next().value as string);
  return password;
}

/**
 * Lazily start (once per process) the egress guard and return credentials
 * for it. With `upstream` (an already validated proxy URL) traffic sent with
 * these credentials is chained through that proxy after validation.
 */
export async function getEgressGuard(upstream?: string): Promise<EgressGuard> {
  if (!serverPromise) {
    serverPromise = startServer().catch((error) => {
      serverPromise = null;
      throw error;
    });
  }
  const { port } = await serverPromise;
  const password = passwordFor(upstream?.trim() || DIRECT);
  return {
    url: `http://${USERNAME}:${password}@127.0.0.1:${port}`,
    server: `http://127.0.0.1:${port}`,
    username: USERNAME,
    password,
  };
}

export async function stopEgressGuard(): Promise<void> {
  const server = guardServer;
  guardServer = null;
  serverPromise = null;
  routes.clear();
  if (!server) return;
  // server.close() only resolves once every connection has ended, and clients
  // keep idle keep-alive (and CONNECT tunnel) sockets open. Destroy them so
  // shutdown never waits on a socket nobody is using any more.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  for (const sock of guardSockets) sock.destroy();
  guardSockets.clear();
  await closed;
}

registerCleanup(stopEgressGuard);
