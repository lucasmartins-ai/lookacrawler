import { describe, it, expect, afterAll, afterEach } from "bun:test";
import { isPrivateAddress, validateProxyUrl } from "./security.js";
import { getEgressGuard, stopEgressGuard } from "./egress-guard.js";
import { fetchHtml } from "./extractor.js";
import { checkSseRequest, resolveSseSecurity } from "./sse-security.js";

afterEach(() => {
  delete process.env.LOOKACRAWLER_ALLOW_LOCAL;
  delete process.env.LOOKACRAWLER_ALLOWED_PROXIES;
});

describe("isPrivateAddress: IPv6 forms that embed an IPv4 address", () => {
  it("catches mapped, NAT64 and 6to4 encodings of internal addresses", () => {
    // new URL("http://[::ffff:127.0.0.1]/").hostname === "[::ffff:7f00:1]"
    expect(isPrivateAddress("[::ffff:7f00:1]")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:a9fe:a9fe")).toBe(true);
    expect(isPrivateAddress("64:ff9b::a9fe:a9fe")).toBe(true);
    expect(isPrivateAddress("2002:7f00:1::")).toBe(true);
    expect(isPrivateAddress("fe80::1%eth0")).toBe(true);
    expect(isPrivateAddress("ff02::1")).toBe(true);
  });

  it("still treats public addresses and look-alike hostnames as public", () => {
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700::6810:85e5")).toBe(false);
    expect(isPrivateAddress("fda.gov")).toBe(false);
  });
});

describe("validateProxyUrl", () => {
  it("rejects proxies pointing at local or internal services", async () => {
    await expect(validateProxyUrl("http://127.0.0.1:6379")).rejects.toThrow("not allowed");
    await expect(validateProxyUrl("http://169.254.169.254")).rejects.toThrow("not allowed");
    await expect(validateProxyUrl("socks5://localhost:9050")).rejects.toThrow("not allowed");
    await expect(validateProxyUrl("http://[::1]:8080")).rejects.toThrow("not allowed");
  });

  it("rejects unsupported schemes and URLs with paths", async () => {
    await expect(validateProxyUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(validateProxyUrl("http://1.1.1.1:8080/admin")).rejects.toThrow("path");
    await expect(validateProxyUrl("not a url")).rejects.toThrow("invalid");
  });

  it("allows public proxies and operator-allowlisted local ones", async () => {
    await expect(validateProxyUrl("http://1.1.1.1:8080")).resolves.toBe("http://1.1.1.1:8080");
    process.env.LOOKACRAWLER_ALLOWED_PROXIES = "socks5://127.0.0.1:9050";
    await expect(validateProxyUrl("socks5://127.0.0.1:9050")).resolves.toBe("socks5://127.0.0.1:9050");
  });
});

describe("Egress guard", () => {
  const internal = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("INTERNAL SECRET") });

  afterAll(async () => {
    internal.stop(true);
    await stopEgressGuard();
  });

  it("refuses connections to internal addresses, whatever the name resolves through", async () => {
    const guard = await getEgressGuard();
    const res = await fetch(`http://127.0.0.1:${internal.port}/`, { proxy: guard.url } as any);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("INTERNAL SECRET");
  });

  it("requires its per-process credentials", async () => {
    const guard = await getEgressGuard();
    const res = await fetch(`http://127.0.0.1:${internal.port}/`, { proxy: guard.server } as any);
    expect(res.status).toBe(407);
  });

  it("forwards traffic when the destination is allowed", async () => {
    process.env.LOOKACRAWLER_ALLOW_LOCAL = "true";
    const guard = await getEgressGuard();
    const res = await fetch(`http://127.0.0.1:${internal.port}/`, { proxy: guard.url } as any);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("INTERNAL SECRET");
  });
});

describe("fetchHtml hardening", () => {
  it("drops caller credentials when a redirect leaves the origin", async () => {
    process.env.LOOKACRAWLER_ALLOW_LOCAL = "true";
    const seen: Record<string, string | null>[] = [];
    const other = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        seen.push({
          authorization: req.headers.get("authorization"),
          cookie: req.headers.get("cookie"),
          apiKey: req.headers.get("x-api-key"),
        });
        return new Response("<html><body><p>landed</p></body></html>", { headers: { "content-type": "text/html" } });
      },
    });
    const origin = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.redirect(`http://127.0.0.1:${other.port}/landing`, 302),
    });
    try {
      await fetchHtml(`http://127.0.0.1:${origin.port}/start`, {
        headers: { Authorization: "Bearer SECRET", "X-Api-Key": "KEY" },
        cookies: { session: "COOKIE" },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({ authorization: null, cookie: null, apiKey: null });
    } finally {
      origin.stop(true);
      other.stop(true);
    }
  });

  it("enforces the size cap on responses without Content-Length", async () => {
    process.env.LOOKACRAWLER_ALLOW_LOCAL = "true";
    const chunk = "x".repeat(1024 * 1024);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        let sent = 0;
        const body = new ReadableStream({
          pull(controller) {
            // Effectively endless: the old code buffered all of it before checking.
            if (sent++ > 200) return controller.close();
            controller.enqueue(new TextEncoder().encode(chunk));
          },
        });
        return new Response(body, { headers: { "content-type": "text/html" } });
      },
    });
    try {
      await expect(fetchHtml(`http://127.0.0.1:${server.port}/`, { timeoutMs: 15000 })).rejects.toThrow(
        "exceeds maximum size"
      );
    } finally {
      server.stop(true);
    }
  }, 20000);
});

describe("SSE access control", () => {
  it("always requires a token on non-loopback binds", () => {
    const cfg = resolveSseSecurity("0.0.0.0", 3000, {});
    expect(cfg.token).toBeDefined();
    expect(cfg.generatedToken).toBe(true);
    expect(checkSseRequest({ method: "GET", headers: { host: "10.0.0.5:3000" } }, cfg)).toMatchObject({ status: 401 });
    expect(
      checkSseRequest({ method: "GET", headers: { host: "10.0.0.5:3000", authorization: `Bearer ${cfg.token}` } }, cfg)
    ).toEqual({ ok: true });
  });

  it("blocks browser pages and rebinding hosts on an unauthenticated loopback server", () => {
    const cfg = resolveSseSecurity("127.0.0.1", 3000, {});
    expect(cfg.token).toBeUndefined();
    expect(checkSseRequest({ method: "GET", headers: { host: "127.0.0.1:3000" } }, cfg)).toEqual({ ok: true });
    expect(
      checkSseRequest({ method: "GET", headers: { host: "127.0.0.1:3000", origin: "https://evil.example" } }, cfg)
    ).toMatchObject({ status: 403 });
    expect(checkSseRequest({ method: "GET", headers: { host: "evil.example:3000" } }, cfg)).toMatchObject({
      status: 403,
    });
  });
});

describe("Deep mode browser is confined by the egress guard", () => {
  it("cannot reach loopback by navigation, in-page fetch or WebSocket", async () => {
    const { getBrowser, closeBrowsers } = await import("./browser-manager.js");
    const internal = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("INTERNAL SECRET") });
    let browser: any;
    try {
      browser = await getBrowser();
    } catch {
      internal.stop(true);
      return; // no Chromium in this environment (CI does not install it)
    }
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      // No page.route here on purpose: this exercises the guard alone, which is
      // what stops redirect hops and page-initiated requests in production.
      await page.goto(`http://127.0.0.1:${internal.port}/`).catch(() => null);
      expect(await page.content()).not.toContain("INTERNAL SECRET");
      await page.goto("about:blank");
      const inPage = await page.evaluate(async (port: number) => {
        try {
          return await (await fetch(`http://127.0.0.1:${port}/`)).text();
        } catch {
          return "blocked";
        }
      }, internal.port);
      expect(inPage).not.toContain("INTERNAL SECRET");
      await context.close();
    } finally {
      internal.stop(true);
      await closeBrowsers();
    }
  }, 30000);
});
