import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolvePublicAddress } from "./security.js";

/**
 * Egress guard: a tiny loopback HTTP/CONNECT proxy that every outbound
 * connection goes through when no upstream proxy is configured.
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
 * Access is protected with random per-process credentials so other local
 * processes cannot use it as an open proxy.
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

let guardPromise: Promise<EgressGuard> | null = null;
let guardServer: Server | null = null;

function isAuthorized(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers["proxy-authorization"];
  if (typeof header !== "string") return false;
  const supplied = Buffer.from(header);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
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

async function openUpstream(host: string, port: number): Promise<net.Socket> {
  const { address } = await resolvePublicAddress(host);
  return await new Promise<net.Socket>((resolve, reject) => {
    const upstream = net.connect({ host: address, port });
    upstream.unref();
    upstream.once("connect", () => resolve(upstream));
    upstream.once("error", reject);
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("upstream timeout")));
  });
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

function startGuard(): Promise<EgressGuard> {
  const username = "lc";
  const password = randomBytes(18).toString("base64url");
  const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);

  const server = createServer(async (req, res) => {
    // Plain-HTTP request in absolute form: "GET http://host/path HTTP/1.1".
    if (!isAuthorized(req, expected)) {
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
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name.startsWith("proxy-") || name === "connection" || name === "keep-alive") continue;
      headers[name] = value;
    }
    headers.host = target.host;
    // Connect to the exact IP we validated; never resolve the name again.
    const upstream = httpRequest(
      {
        host: address,
        port: target.port ? Number(target.port) : 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        setHost: false,
        timeout: 30_000,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on("socket", (sock) => sock.unref());
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { [BLOCKED_HEADER]: "1" });
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("connect", async (req: IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    if (!isAuthorized(req, expected)) {
      rejectSocket(socket, "407 Proxy Authentication Required", "proxy authentication required", PROXY_AUTH_CHALLENGE);
      return;
    }
    const dest = parseHostPort(req.url || "", 443);
    if (!dest) {
      rejectSocket(socket, "400 Bad Request", "invalid CONNECT target");
      return;
    }
    let upstream: net.Socket;
    try {
      upstream = await openUpstream(dest.host, dest.port);
    } catch (error) {
      rejectSocket(socket, "403 Forbidden", error instanceof Error ? error.message : String(error));
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    pipeBoth(socket, upstream);
  });

  // The guard must never keep the process alive on its own: the in-process
  // client (fetch / the awaited browser call) already does while a request is
  // in flight, and a short-lived CLI run has to exit as soon as it is done.
  server.on("connection", (sock: net.Socket) => sock.unref());

  return new Promise<EgressGuard>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("egress guard failed to bind"));
        return;
      }
      server.unref();
      guardServer = server;
      const serverUrl = `http://127.0.0.1:${address.port}`;
      resolve({
        url: `http://${username}:${password}@127.0.0.1:${address.port}`,
        server: serverUrl,
        username,
        password,
      });
    });
  });
}

/** Lazily start (once per process) and return the egress guard. */
export function getEgressGuard(): Promise<EgressGuard> {
  if (!guardPromise) {
    guardPromise = startGuard().catch((error) => {
      guardPromise = null;
      throw error;
    });
  }
  return guardPromise;
}

export async function stopEgressGuard(): Promise<void> {
  const server = guardServer;
  guardServer = null;
  guardPromise = null;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
}
